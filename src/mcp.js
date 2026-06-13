/**
 * mcp.js — minimal MCP client over stdio (JSON-RPC 2.0, newline-delimited).
 * Servers from config.mcp_servers: { name: { command, args, env } }.
 * Their tools surface as mcp__<server>__<tool> in the registry.
 */
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2025-06-18";

class McpServer {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.status = "stopped"; // stopped | starting | ready | failed
    this.error = null;
    this.buf = "";
  }

  async start(timeoutMs = 12000) {
    if (this.status === "ready") return;
    this.status = "starting";
    try {
      this.child = spawn(this.spec.command, this.spec.args || [], {
        env: { ...process.env, ...(this.spec.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.spec.command),
      });
    } catch (err) {
      this.status = "failed";
      this.error = err.message;
      throw err;
    }
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", () => {
      /* server logs are ignored */
    });
    this.child.on("close", () => {
      this.status = this.status === "ready" ? "stopped" : "failed";
      for (const [, p] of this.pending) p.reject(new Error(`MCP server ${this.name} exited`));
      this.pending.clear();
    });
    this.child.on("error", (err) => {
      this.status = "failed";
      this.error = err.message;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "claudeseek", version: "1.0.0" },
      },
      timeoutMs
    );
    this.notify("notifications/initialized", {});
    const res = await this.request("tools/list", {}, timeoutMs);
    this.tools = res?.tools || [];
    this.status = "ready";
  }

  #onData(data) {
    this.buf += data.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name} ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.child.stdin.write(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* dead pipe surfaces on next request */
    }
  }

  async callTool(name, args, timeoutMs = 60000) {
    const res = await this.request("tools/call", { name, arguments: args || {} }, timeoutMs);
    const parts = (res?.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`));
    return { ok: !res?.isError, output: parts.join("\n") || "(empty result)" };
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      /* already dead */
    }
    this.status = "stopped";
  }
}

export class McpManager {
  constructor(config) {
    this.servers = new Map();
    for (const [name, spec] of Object.entries(config?.mcp_servers || {})) {
      if (spec?.command) this.servers.set(name, new McpServer(name, spec));
    }
  }

  /** Connect all configured servers (lazily tolerant — failures recorded). */
  async startAll() {
    await Promise.all(
      [...this.servers.values()].map(async (s) => {
        try {
          await s.start();
        } catch (err) {
          s.status = "failed";
          s.error = err?.message || String(err);
        }
      })
    );
  }

  /** claudeseek tool descriptors for every ready MCP tool. */
  toolDescriptors() {
    const out = [];
    for (const server of this.servers.values()) {
      if (server.status !== "ready") continue;
      for (const t of server.tools) {
        out.push({
          name: `mcp__${server.name}__${t.name}`,
          // MCP tools are arbitrary external code (a server can read files, run
          // shells, hit the network). Gate them behind the approval pipeline by
          // default (kind "mcp" -> #ask). A server the user explicitly trusts in
          // config (`trusted: true`) opts its tools back into auto-allow.
          kind: server.spec.trusted === true ? "net" : "mcp",
          description: `[MCP:${server.name}] ${t.description || t.name}`.slice(0, 1000),
          parameters: t.inputSchema || { type: "object", properties: {} },
          execute: async (input) => {
            try {
              return await server.callTool(t.name, input);
            } catch (err) {
              return { ok: false, output: `MCP call failed: ${err.message}` };
            }
          },
        });
      }
    }
    return out;
  }

  diagnostics() {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      status: s.status,
      tools: s.tools.length,
      error: s.error,
    }));
  }

  stopAll() {
    for (const s of this.servers.values()) s.stop();
  }
}
