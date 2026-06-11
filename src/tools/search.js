/**
 * search.js — glob + grep in pure JS (no ripgrep dependency).
 * Bounded walker: skips VCS/dependency/cache dirs, binary files, and caps
 * results so a careless pattern can't flood the context window.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", ".tox", "coverage", ".cache", ".idea", ".vscode",
  ".claudeseek", "vendor", "target", ".pnpm-store",
]);
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar", "7z", "rar",
  "exe", "dll", "so", "dylib", "bin", "woff", "woff2", "ttf", "eot", "mp3", "mp4",
  "mov", "avi", "sqlite", "db", "wasm", "pyc", "class", "jar",
]);
const MAX_FILES_WALKED = 50000;
const MAX_GREP_FILE_BYTES = 1.5 * 1024 * 1024;

function* walk(root, depthLeft = 12, state = { count: 0 }) {
  if (state.count > MAX_FILES_WALKED || depthLeft < 0) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (state.count > MAX_FILES_WALKED) return;
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".git")) continue;
      yield* walk(full, depthLeft - 1, state);
    } else if (e.isFile()) {
      state.count++;
      yield full;
    }
  }
}

/** Convert a glob pattern (** / * / ?) to a RegExp over posix-ish paths. */
export function globToRegExp(pattern) {
  let re = "";
  const p = pattern.replace(/\\/g, "/");
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        re += "(?:.*)";
        i++;
        if (p[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if ("\\.[]{}()+^$|".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(`^${re}$`, "i");
}

export const globTool = {
  name: "glob",
  kind: "read",
  description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Sorted by mtime (newest first).',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search (default workspace root)" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const root = resolve(ctx.cwd, input.path || ".");
    if (!existsSync(root)) return { ok: false, output: `Not found: ${root}` };
    const rx = globToRegExp(input.pattern);
    const hits = [];
    for (const file of walk(root)) {
      const rel = relative(root, file).split(sep).join("/");
      if (rx.test(rel) || rx.test("/" + rel)) {
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          /* unreadable entries sort last */
        }
        hits.push({ file, mtime });
        if (hits.length >= 2000) break;
      }
    }
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, 200).map((h) => h.file);
    const extra = hits.length > 200 ? `\n… ${hits.length - 200} more` : "";
    return {
      ok: true,
      output: shown.length ? shown.join("\n") + extra : "No files matched.",
      meta: { matches: hits.length },
    };
  },
};

export const grepTool = {
  name: "grep",
  kind: "read",
  description:
    "Search file contents with a JavaScript regex. Returns path:line:text matches (capped). Use include to filter by glob.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory or file to search (default workspace root)" },
      include: { type: "string", description: 'Glob filter like "*.ts" (optional)' },
      ignore_case: { type: "boolean", description: "Case-insensitive (default false)" },
      max_results: { type: "integer", description: "Cap matches (default 100)" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const root = resolve(ctx.cwd, input.path || ".");
    if (!existsSync(root)) return { ok: false, output: `Not found: ${root}` };
    let rx;
    try {
      rx = new RegExp(input.pattern, input.ignore_case ? "i" : "");
    } catch (err) {
      return { ok: false, output: `Invalid regex: ${err.message}` };
    }
    const includeRx = input.include ? globToRegExp(`**/${input.include}`) : null;
    const cap = Math.min(500, Math.max(1, Number(input.max_results) || 100));
    const matches = [];
    const files = statSync(root).isFile() ? [root] : walk(root);
    let scanned = 0;
    for (const file of files) {
      if (matches.length >= cap) break;
      const ext = file.split(".").pop()?.toLowerCase() || "";
      if (BINARY_EXT.has(ext)) continue;
      const rel = relative(ctx.cwd, file).split(sep).join("/") || file;
      if (includeRx && !includeRx.test(rel)) continue;
      let content;
      try {
        if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;
      scanned++;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < cap; i++) {
        if (rx.test(lines[i])) {
          const text = lines[i].length > 400 ? lines[i].slice(0, 400) + "…" : lines[i];
          matches.push(`${rel}:${i + 1}:${text.trim()}`);
        }
      }
    }
    return {
      ok: true,
      output: matches.length ? matches.join("\n") : `No matches (scanned ${scanned} files).`,
      meta: { matches: matches.length, scanned },
    };
  },
};
