/**
 * shell.js — the bash tool. On Windows it runs PowerShell, elsewhere bash.
 * Approval-gated (not an OS sandbox): a hard blocklist stops broadly
 * destructive commands in every permission mode, and everything non-safe
 * goes through the permission pipeline before execution.
 */
import { spawn } from "node:child_process";

const HARD_BLOCK = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+([\/~]|\$home|[a-z]:\\(?:\s|$))/i,
  /\bdel\s+\/[sq]\s+\/[sq]?\s*[a-z]:\\(?:\s|$)/i,
  /\brd\s+\/s\s+\/q\s+[a-z]:\\(?:\s|$)/i,
  /\bremove-item\b[^|;]*-recurse[^|;]*[a-z]:\\(?:\s|$)/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bRestart-Computer\b|\bStop-Computer\b/i,
  /\breg\s+delete\s+HKLM/i,
  /:\(\)\s*\{\s*:\|\s*:&\s*\};:/, // fork bomb
  /\bgit\s+push\s+.*--force\b.*\b(main|master)\b/i,
];

/** Read-only command prefixes that are safe to auto-allow in default mode. */
const SAFE_PREFIXES = [
  "git status", "git log", "git diff", "git branch", "git show", "git remote",
  "ls", "dir", "pwd", "whoami", "node --version", "node -v", "npm --version",
  "npm -v", "python --version", "pip --version", "cat ", "type ", "echo ",
  "Get-ChildItem", "Get-Content", "Get-Location", "Get-Date", "where ", "which ",
];

export function classifyCommand(command) {
  const cmd = String(command || "").trim();
  for (const rx of HARD_BLOCK) {
    if (rx.test(cmd)) return "blocked";
  }
  const lower = cmd.toLowerCase();
  if (SAFE_PREFIXES.some((p) => lower === p.toLowerCase().trim() || lower.startsWith(p.toLowerCase()))) {
    // chained commands lose the safe fast-path
    if (!/[;&|><`$(]/.test(cmd.replace(/\|\s*(more|less|head|tail|select-object|findstr|grep)\b.*/i, ""))) {
      return "safe";
    }
  }
  return "needs-approval";
}

export const bashTool = {
  name: "bash",
  kind: "shell",
  description:
    "Run a shell command in the workspace (PowerShell on Windows, bash elsewhere). Output is truncated to 30000 chars. Long-running daemons are not supported — commands time out.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout_ms: { type: "integer", description: "Timeout in ms (default 120000, max 600000)" },
      description: { type: "string", description: "One line: what this command does" },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const command = String(input.command || "").trim();
    if (!command) return { ok: false, output: "Empty command." };
    if (classifyCommand(command) === "blocked") {
      return { ok: false, output: "Command blocked by claudeseek safety rules (broadly destructive pattern)." };
    }
    const timeout = Math.min(600000, Math.max(1000, Number(input.timeout_ms) || 120000));
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "bash";
    const args = isWin
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
      : ["-c", command];

    return await new Promise((resolveP) => {
      let out = "";
      let settled = false;
      const child = spawn(shell, args, {
        cwd: ctx.cwd,
        env: { ...process.env, CLAUDESEEK: "1" },
        windowsHide: true,
      });
      const finish = (ok, suffix = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let text = out.length > 30000 ? out.slice(0, 30000) + `\n… (truncated, ${out.length} chars total)` : out;
        resolveP({ ok, output: (text.trim() || "(no output)") + suffix });
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        finish(false, `\n[claudeseek] command timed out after ${timeout}ms`);
      }, timeout);
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        finish(false, "\n[claudeseek] aborted by user");
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (out += d.toString()));
      child.on("error", (err) => finish(false, `\n[claudeseek] spawn error: ${err.message}`));
      child.on("close", (code) => {
        ctx.signal?.removeEventListener?.("abort", onAbort);
        finish(code === 0, code === 0 ? "" : `\n[exit code ${code}]`);
      });
    });
  },
};
