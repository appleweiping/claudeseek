/**
 * permissions.js — composable permission pipeline.
 *
 * Decision order, first non-null wins:
 *   1. hard rules        (blocked commands → deny, always)
 *   2. mode rules        (plan → read-only; bypassPermissions → allow)
 *   3. session rules     ("always allow" grants accumulated this session)
 *   4. kind defaults     (read/meta → allow; write → ask unless acceptEdits;
 *                         shell safe-prefix → allow, else ask; net → ask, and
 *                         "always" covers that one host; mcp → ask unless the
 *                         server is marked trusted in the user's config)
 *   5. asker callback    (interactive UI / server approval / headless policy)
 *
 * Modes (same names Claude Code uses): default | acceptEdits | bypassPermissions | plan.
 */
import { classifyCommand } from "./tools/shell.js";
import { resolve, relative, isAbsolute } from "node:path";

export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"];

export class Permissions {
  /**
   * @param {object} opts {mode, cwd, asker?: async(req)=>'allow'|'always'|'deny'}
   */
  constructor({ mode = "default", cwd = process.cwd(), asker = null }) {
    this.mode = mode;
    this.cwd = cwd;
    this.asker = asker;
    this.sessionAllow = new Set(); // rule keys granted "always" this session
  }

  setMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    this.mode = mode;
  }

  ruleKey(tool, input) {
    if (tool.name === "bash") {
      const word = String(input.command || "").trim().split(/\s+/).slice(0, 2).join(" ");
      return `bash:${word}`;
    }
    if (tool.kind === "write") return `write:*`;
    if (tool.kind === "net") return `${tool.name}:${hostOf(input.url)}`;
    return `${tool.name}:*`;
  }

  /** @returns {Promise<{behavior:'allow'|'deny', reason:string}>} */
  async check(tool, input, { signal } = {}) {
    // 1. hard rules
    if (tool.name === "bash" && classifyCommand(input.command) === "blocked") {
      return { behavior: "deny", reason: "blocked by safety rules" };
    }

    // 2. mode rules
    if (this.mode === "plan" && tool.kind !== "read" && tool.kind !== "meta") {
      return { behavior: "deny", reason: "plan mode is read-only (use /mode default to act)" };
    }
    if (this.mode === "bypassPermissions") return { behavior: "allow", reason: "bypassPermissions" };

    // 3. session "always" grants
    if (this.sessionAllow.has(this.ruleKey(tool, input))) {
      return { behavior: "allow", reason: "session rule" };
    }

    // 4. kind defaults
    if (tool.kind === "read" || tool.kind === "meta") {
      return { behavior: "allow", reason: "safe tool" };
    }
    // Reads are allowed anywhere the user can read, so a network request is
    // where file contents could leave the machine (in a query string, say).
    // Ask, and let "always" cover only the host that was shown.
    if (tool.kind === "net") {
      return this.#ask(tool, input, signal);
    }
    // MCP tools are external programs. They ask unless the user marked the
    // server `trusted: true` in ~/.claudeseek/config.json; an "always" grant
    // (step 3 above) also allows that tool for the rest of the session.
    if (tool.kind === "mcp") {
      if (tool.trusted === true) return { behavior: "allow", reason: "trusted MCP server" };
      return this.#ask(tool, input, signal);
    }
    if (tool.kind === "write") {
      if (this.mode === "acceptEdits") {
        // Writes that escape the workspace still ask even in acceptEdits.
        // Use a path-segment-aware containment check: a raw prefix match would
        // treat C:\proj-secrets\x as inside cwd C:\proj. relative() is '' for
        // the dir itself and starts with '..' (or is absolute on another drive)
        // for anything outside.
        const target = resolve(this.cwd, String(input.path || ""));
        const rel = relative(this.cwd, target);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
          return { behavior: "allow", reason: "acceptEdits" };
        }
      }
      return this.#ask(tool, input, signal);
    }
    if (tool.kind === "shell") {
      if (classifyCommand(input.command) === "safe") return { behavior: "allow", reason: "safe command" };
      return this.#ask(tool, input, signal);
    }
    return this.#ask(tool, input, signal);
  }

  async #ask(tool, input, signal) {
    if (!this.asker) return { behavior: "deny", reason: "no approver available (non-interactive)" };
    // alwaysHint tells the UI what an "always" answer will cover, when that is
    // narrower than the whole tool (fetch_url: one host).
    const alwaysHint = tool.kind === "net" ? hostOf(input.url) : null;
    const decision = await this.asker({
      tool: tool.name,
      kind: tool.kind,
      input,
      preview: previewOf(tool, input),
      alwaysHint,
      signal,
    });
    if (decision === "always") {
      this.sessionAllow.add(this.ruleKey(tool, input));
      return { behavior: "allow", reason: "user approved (always)" };
    }
    if (decision === "allow") return { behavior: "allow", reason: "user approved" };
    return { behavior: "deny", reason: "user denied" };
  }
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).host.toLowerCase() || "(no host)";
  } catch {
    return "(invalid url)";
  }
}

/** One-line human preview of a tool call for approval prompts. */
export function previewOf(tool, input) {
  const name = typeof tool === "string" ? tool : tool.name;
  switch (name) {
    case "bash":
      return String(input.command || "").slice(0, 300);
    case "write_file":
      return `${input.path} (${String(input.content || "").length} chars)`;
    case "edit_file":
      return `${input.path} (replace ${String(input.old_string || "").slice(0, 60)}…)`;
    case "read_file":
    case "list_dir":
      return String(input.path || ".");
    case "glob":
    case "grep":
      return String(input.pattern || "");
    case "fetch_url":
      return String(input.url || "");
    case "task":
      return String(input.description || "").slice(0, 120);
    default:
      return JSON.stringify(input).slice(0, 200);
  }
}
