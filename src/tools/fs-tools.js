/**
 * fs-tools.js — read_file / write_file / edit_file / list_dir.
 * Mirrors Claude Code's file tools: line-numbered reads, exact-match edits
 * with uniqueness enforcement, undo snapshots before every mutation.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 2000;
const MAX_LINE_LEN = 2000;

export function resolvePath(ctx, p) {
  return resolve(ctx.cwd, String(p || ""));
}

export const readFileTool = {
  name: "read_file",
  kind: "read",
  description:
    "Read a text file. Returns content with line numbers (cat -n style). Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to workspace)" },
      offset: { type: "integer", description: "1-based line to start from (optional)" },
      limit: { type: "integer", description: "Max lines to return (default 2000)" },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const path = resolvePath(ctx, input.path);
    if (!existsSync(path)) return { ok: false, output: `File not found: ${path}` };
    const st = statSync(path);
    if (st.isDirectory()) return { ok: false, output: `${path} is a directory — use list_dir.` };
    if (st.size > MAX_READ_BYTES) {
      return { ok: false, output: `File too large (${st.size} bytes). Use offset/limit or grep to inspect parts.` };
    }
    const raw = readFileSync(path);
    if (looksBinary(raw)) return { ok: false, output: `Binary file (${st.size} bytes): ${path}` };
    const lines = raw.toString("utf8").split(/\r?\n/);
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(input.limit) || MAX_READ_LINES));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + "…" : l}`)
      .join("\n");
    const more = lines.length > offset - 1 + limit ? `\n… (${lines.length} lines total)` : "";
    ctx.fileState?.noteRead(path, raw.toString("utf8"));
    return { ok: true, output: numbered + more, meta: { path, lines: slice.length } };
  },
};

export const writeFileTool = {
  name: "write_file",
  kind: "write",
  description: "Create or overwrite a file with the given content. Parent directories are created.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const path = resolvePath(ctx, input.path);
    ctx.undo?.snapshot(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(input.content), "utf8");
    ctx.fileState?.noteWrite(path, String(input.content));
    const lineCount = String(input.content).split("\n").length;
    return { ok: true, output: `Wrote ${lineCount} lines to ${path}`, meta: { path } };
  },
};

export const editFileTool = {
  name: "edit_file",
  kind: "write",
  description:
    "Replace an exact string in a file. old_string must match exactly once (include surrounding context to disambiguate); set replace_all to change every occurrence.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    const path = resolvePath(ctx, input.path);
    if (!existsSync(path)) return { ok: false, output: `File not found: ${path}` };
    const content = readFileSync(path, "utf8");
    const oldStr = String(input.old_string);
    const newStr = String(input.new_string);
    if (oldStr === newStr) return { ok: false, output: "old_string and new_string are identical." };
    const count = countOccurrences(content, oldStr);
    if (count === 0) {
      return { ok: false, output: `old_string not found in ${path}. Read the file and match the text exactly (watch indentation).` };
    }
    if (count > 1 && !input.replace_all) {
      return {
        ok: false,
        output: `old_string occurs ${count} times in ${path}. Add surrounding context to make it unique, or set replace_all=true.`,
      };
    }
    ctx.undo?.snapshot(path);
    const updated = input.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    writeFileSync(path, updated, "utf8");
    ctx.fileState?.noteWrite(path, updated);
    return { ok: true, output: `Edited ${path} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? "s" : ""})`, meta: { path } };
  },
};

export const listDirTool = {
  name: "list_dir",
  kind: "read",
  description: "List entries of a directory (name, type, size).",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path (default workspace root)" } },
  },
  async execute(input, ctx) {
    const path = resolvePath(ctx, input.path || ".");
    if (!existsSync(path)) return { ok: false, output: `Not found: ${path}` };
    if (!statSync(path).isDirectory()) return { ok: false, output: `${path} is a file — use read_file.` };
    const entries = readdirSync(path, { withFileTypes: true })
      .slice(0, 500)
      .map((e) => {
        let size = "";
        try {
          if (e.isFile()) size = ` (${statSync(join(path, e.name)).size}B)`;
        } catch {
          /* permission issues are non-fatal in listings */
        }
        return `${e.isDirectory() ? "d " : "- "}${e.name}${size}`;
      });
    return { ok: true, output: entries.join("\n") || "(empty)", meta: { path } };
  },
};

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
