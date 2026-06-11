/**
 * todo.js — in-session structured task list (Claude Code's TodoWrite pattern).
 * The model replaces the whole list each call; the UI renders it live.
 */

export const todoTool = {
  name: "todo_write",
  kind: "meta",
  description:
    "Replace the session todo list. Use for multi-step work: statuses are pending | in_progress | completed. Keep exactly one item in_progress while working.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative task title" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(input, ctx) {
    const todos = (Array.isArray(input.todos) ? input.todos : [])
      .slice(0, 50)
      .map((t) => ({
        content: String(t.content || "").slice(0, 300),
        status: ["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending",
      }))
      .filter((t) => t.content);
    ctx.session.todos = todos;
    ctx.events?.emit("todos", todos);
    const done = todos.filter((t) => t.status === "completed").length;
    return {
      ok: true,
      output: `Todo list updated: ${todos.length} items (${done} completed).\n` +
        todos.map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`).join("\n"),
      meta: { todos },
    };
  },
};
