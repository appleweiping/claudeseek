/**
 * memory.js — agentmemory bridge (the workstation's single source of truth,
 * http://localhost:3111) with an offline outbox fallback.
 *
 * Protocol compliance (D:\devtools\AGENT-MEMORY-PROTOCOL.md):
 *  - every record carries concepts including the identity tag `agent:claudeseek`
 *  - canonical lowercase-hyphen `project` name, `_global` when none
 *  - typed records (fact|bug|architecture|pattern|preference|workflow)
 *  - no per-iteration logs: claudeseek only saves on explicit /remember or
 *    meaningful session close.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userDir } from "./config.js";

const IDENTITY = "agent:claudeseek";

export class MemoryBridge {
  constructor(config) {
    this.base = (process.env.AGENTMEMORY_URL || config?.memory?.agentmemory_url || "http://localhost:3111").replace(/\/+$/, "");
    this.enabled = config?.memory?.enabled !== false && !truthy(process.env.CLAUDESEEK_DISABLE_AGENTMEMORY);
  }

  headers() {
    const h = { "Content-Type": "application/json" };
    if (process.env.AGENTMEMORY_SECRET) h.Authorization = `Bearer ${process.env.AGENTMEMORY_SECRET}`;
    return h;
  }

  async health() {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    try {
      const res = await fetch(`${this.base}/agentmemory/health`, { signal: AbortSignal.timeout(1500) }).catch(() =>
        fetch(this.base, { signal: AbortSignal.timeout(1500) })
      );
      return { ok: !!res && res.status < 500, status: res?.status };
    } catch (err) {
      return { ok: false, reason: err?.message || "unreachable" };
    }
  }

  /**
   * Save a memory. Falls back to ~/.claudeseek/memory-outbox/*.md when the
   * service is unreachable so nothing is lost.
   */
  async remember({ content, type = "fact", project = "_global", concepts = [] }) {
    const allConcepts = [...new Set([IDENTITY, ...concepts])];
    const payload = { content, type, project, concepts: allConcepts };
    if (this.enabled) {
      try {
        const res = await fetch(`${this.base}/agentmemory/remember`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) return { saved: true, via: "agentmemory" };
        return { saved: false, via: "outbox", path: this.#outbox(payload), error: `HTTP ${res.status}` };
      } catch (err) {
        return { saved: false, via: "outbox", path: this.#outbox(payload), error: err?.message };
      }
    }
    return { saved: false, via: "outbox", path: this.#outbox(payload), error: "disabled" };
  }

  /** Best-effort recall; returns [] when the service is down. */
  async search(query, limit = 5) {
    if (!this.enabled) return [];
    for (const route of ["/agentmemory/smart-search", "/agentmemory/search", "/agentmemory/recall"]) {
      try {
        const res = await fetch(`${this.base}${route}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ query, limit }),
          signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        const items = data?.results || data?.memories || (Array.isArray(data) ? data : []);
        if (Array.isArray(items)) {
          return items.slice(0, limit).map((it) => ({
            content: String(it.content || it.text || "").slice(0, 600),
            type: it.type,
            project: it.project,
          }));
        }
      } catch {
        /* try next route */
      }
    }
    return [];
  }

  #outbox(payload) {
    try {
      const dir = join(userDir(), "memory-outbox");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = join(dir, `claudeseek-${stamp}.md`);
      const body = [
        "---",
        `type: ${payload.type}`,
        `project: ${payload.project}`,
        `concepts: [${payload.concepts.join(", ")}]`,
        `created: ${new Date().toISOString()}`,
        "---",
        "",
        payload.content,
        "",
      ].join("\n");
      writeFileSync(path, body, "utf8");
      return path;
    } catch {
      return null;
    }
  }
}

function truthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v || "").toLowerCase());
}

/**
 * One-shot recall used on the first turn of a session: returns a context block
 * to append to the user message, or "" when nothing relevant / service down.
 */
export async function recallBlock(bridge, query) {
  try {
    const hits = await bridge.search(String(query).slice(0, 300), 3);
    if (!hits.length) return "";
    const lines = hits.map((h, i) => `${i + 1}. [${h.type || "fact"}${h.project ? ` · ${h.project}` : ""}] ${h.content}`);
    return `\n\n[agentmemory recall — background context, verify before relying on it]\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}
