/**
 * task.js — sub-agent tool (Claude Code's AgentTool, message-centric).
 * Spawns a bounded in-process agent with a restricted toolset; its final text
 * returns as the tool result wrapped in <task-notification> so the parent
 * model reads it as structured context, not RPC.
 */

export const taskTool = {
  name: "task",
  kind: "meta",
  description:
    "Spawn a focused sub-agent for a self-contained job (research a question across files, implement an isolated change, verify a claim). The sub-agent has read/search/shell/file tools but cannot spawn further agents. Returns its final report.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short task label (3-8 words)" },
      prompt: { type: "string", description: "Full standalone instructions for the sub-agent" },
      readonly: { type: "boolean", description: "Restrict to read-only tools (default false)" },
    },
    required: ["description", "prompt"],
  },
  async execute(input, ctx) {
    if (!ctx.spawnSubagent) return { ok: false, output: "Sub-agents unavailable in this context." };
    if ((ctx.depth || 0) >= (ctx.config?.subagents?.max_depth ?? 2)) {
      return { ok: false, output: "Max sub-agent depth reached — do the work directly." };
    }
    const started = Date.now();
    try {
      const result = await ctx.spawnSubagent({
        description: String(input.description || "subtask"),
        prompt: String(input.prompt || ""),
        readonly: !!input.readonly,
      });
      const xml = [
        "<task-notification>",
        `  <task>${escapeXml(String(input.description))}</task>`,
        `  <status>${result.ok ? "completed" : "failed"}</status>`,
        `  <turns>${result.turns}</turns>`,
        `  <duration_ms>${Date.now() - started}</duration_ms>`,
        "  <result>",
        escapeXml(result.text || "(no output)"),
        "  </result>",
        "</task-notification>",
      ].join("\n");
      return { ok: result.ok, output: xml, meta: { turns: result.turns } };
    } catch (err) {
      return { ok: false, output: `sub-agent failed: ${err?.message || err}` };
    }
  },
};

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
