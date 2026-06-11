/**
 * tools/index.js — tool registry. Builds the DeepSeek function-calling specs
 * and dispatches execution. MCP tools are merged in at engine startup.
 */
import { readFileTool, writeFileTool, editFileTool, listDirTool } from "./fs-tools.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";
import { fetchUrlTool } from "./web.js";
import { todoTool } from "./todo.js";
import { taskTool } from "./task.js";

export const CORE_TOOLS = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  todoTool,
  taskTool,
];

export const READONLY_TOOL_NAMES = new Set(["read_file", "list_dir", "glob", "grep", "fetch_url", "todo_write"]);

export function buildRegistry({ includeTask = true, readonly = false, mcpTools = [] } = {}) {
  let tools = CORE_TOOLS.slice();
  if (!includeTask) tools = tools.filter((t) => t.name !== "task");
  if (readonly) tools = tools.filter((t) => READONLY_TOOL_NAMES.has(t.name));
  tools = tools.concat(mcpTools);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: tools,
    get: (name) => byName.get(name) || null,
    specs: () =>
      tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
  };
}
