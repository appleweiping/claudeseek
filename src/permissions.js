/**
 * permissions.js — composable permission pipeline (Claude Code pattern).
 *
 * Decision order, first non-null wins:
 *   1. hard rules        (blocked commands → deny, always)
 *   2. mode rules        (plan → read-only; bypassPermissions → allow)
 *   3. session rules     ("always allow" grants accumulated this session)
 *   4. kind defaults     (read/meta → allow; write → ask unless acceptEdits;
 *                         shell safe-prefix → allow, else ask; net → allow)
 *   5. asker callback    (interactive UI / server approval / headless policy)
 *
 * Modes mirror Claude Code: default | acceptEdits | bypassPermissions | plan.
 */
import { classifyCommand } from "./tools/shell.js";
import { resolve } from "node:path";

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
    if (tool.kind === "read" || tool.kind === "meta" || tool.kind === "net") {
      return { behavior: "allow", reason: "safe tool" };
    }
    if (tool.kind === "write") {
      if (this.mode === "acceptEdits") {
        // Writes that escape the workspace still ask even in acceptEdits.
        const target = resolve(this.cwd, String(input.path || ""));
        if (target.toLowerCase().startsWith(this.cwd.toLowerCase())) {
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
    const decision = await this.asker({ tool: tool.name, kind: tool.kind, input, preview: previewOf(tool, input), signal });
    if (decision === "always") {
      this.sessionAllow.add(this.ruleKey(tool, input));
      return { behavior: "allow", reason: "user approved (always)" };
    }
    if (decision === "allow") return { behavior: "allow", reason: "user approved" };
    return { behavior: "deny", reason: "user denied" };
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
