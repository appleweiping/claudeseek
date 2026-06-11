/**
 * context.js — system prompt assembly (Claude Code's queryContext pattern).
 * Identity + environment + project memory files + skills inventory, assembled
 * fresh per session and kept stable within it (DeepSeek prefix-cache friendly).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { NAME, VERSION } from "./version.js";

const MEMORY_FILES = ["CLAUDESEEK.md", "CLAUDE.md", "AGENTS.md"];
const MEMORY_CAP = 12000;

export function buildSystemPrompt({ cwd, model, permissionMode, skills = [], extraSystem = "" }) {
  const parts = [];

  parts.push(`You are ${NAME} v${VERSION}, an AI coding agent running in the user's ${
    process.platform === "win32" ? "Windows" : process.platform
  } terminal/browser. You fuse Claude Code's agent discipline with the DeepSeek V4 engine.

# Core conduct
- Be direct and concise. Lead with the outcome. No filler, no flattery.
- Use tools to gather facts before answering; never guess file contents.
- For multi-step work, maintain the todo list via todo_write (one item in_progress at a time).
- Make edits minimal and idiomatic to the surrounding code. Never invent APIs.
- After mutating files or running builds/tests, verify the result and report it faithfully — if something failed, say so with the output.
- Reply in the user's language (中文 ↔ English follow the user).

# Tool rules
- read_file before edit_file: edits require the exact current text.
- Prefer glob/grep over shell for file discovery and content search.
- bash runs ${process.platform === "win32" ? "PowerShell" : "bash"} in the workspace; destructive commands are blocked and risky ones need user approval — if approval is denied, adapt instead of retrying the same call.
- Output only what the task needs; tool results are already shown to the user.

# Safety
- Never exfiltrate secrets (.env, keys, tokens) into responses, commits, or network calls.
- Stay inside the workspace unless the user explicitly directs otherwise.`);

  parts.push(`# Environment
- workspace: ${cwd}
- platform: ${process.platform} (${process.arch}) · node ${process.version}
- date: ${new Date().toISOString().slice(0, 10)}
- model: ${model} · permission mode: ${permissionMode}`);

  const memory = loadProjectMemory(cwd);
  if (memory) parts.push(memory);

  if (skills.length) {
    parts.push(
      `# Skills available\n` +
        skills.map((s) => `- ${s.name}: ${s.description} (read ${s.path} when relevant)`).join("\n")
    );
  }

  if (extraSystem) parts.push(extraSystem);
  return parts.join("\n\n");
}

/** Load the first project memory file found at cwd plus the user-global one. */
export function loadProjectMemory(cwd) {
  const found = [];
  for (const name of MEMORY_FILES) {
    const p = join(cwd, name);
    if (existsSync(p)) {
      found.push({ p, label: `project ${name}` });
      break; // first project file wins (CLAUDESEEK.md > CLAUDE.md > AGENTS.md)
    }
  }
  const globalP = join(homedir(), ".claudeseek", "CLAUDESEEK.md");
  if (existsSync(globalP)) found.push({ p: globalP, label: "user global CLAUDESEEK.md" });
  if (!found.length) return "";
  const chunks = found.map(({ p, label }) => {
    let body = "";
    try {
      body = readFileSync(p, "utf8");
    } catch {
      return "";
    }
    if (body.length > MEMORY_CAP) body = body.slice(0, MEMORY_CAP) + "\n… (truncated)";
    return `## ${label} (${basename(p)})\n${body.trim()}`;
  });
  return `# Project memory (follow these instructions)\n${chunks.filter(Boolean).join("\n\n")}`;
}
