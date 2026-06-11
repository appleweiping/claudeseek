/**
 * e2e-core.mjs — engine + tools + permissions + undo + compaction, offline.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "./fake-deepseek.mjs";

const { server, url } = await startFake();
process.env.DEEPSEEK_API_KEY = "sk-fake-e2e";
process.env.DEEPSEEK_BASE_URL = url;
process.env.CLAUDESEEK_DISABLE_AGENTMEMORY = "1";

const { loadConfig } = await import("../src/config.js");
const { Engine } = await import("../src/engine.js");
const { compactMessages, estimateMessagesTokens } = await import("../src/compact.js");
const { DeepSeekClient } = await import("../src/api.js");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${extra}`);
  }
};

const cwd = mkdtempSync(join(tmpdir(), "cseek-e2e-"));
const config = loadConfig(cwd);
config.agent.permission_mode = "default";

async function run(engine, text) {
  const events = [];
  for await (const ev of engine.submit(text)) events.push(ev);
  return events;
}
const byType = (evs, t) => evs.filter((e) => e.type === t);

console.log("e2e-core: plain streaming");
{
  const engine = new Engine({ config, cwd, asker: async () => "allow" });
  const evs = await run(engine, "PING");
  check("streams text", byType(evs, "text").length > 0);
  check("done = pong", byType(evs, "done")[0]?.text.includes("pong"), JSON.stringify(byType(evs, "done")));
  check("usage recorded", engine.cost.state.requests >= 1);
  check("cache accounting", engine.cost.state.cacheHitTokens > 0);
}

console.log("e2e-core: reasoning stream");
{
  const engine = new Engine({ config, cwd, asker: async () => "allow" });
  const evs = await run(engine, "REASONING_TEST");
  check("reasoning events", byType(evs, "reasoning").length > 0);
  check("text after reasoning", byType(evs, "done")[0]?.text.includes("answer"));
}

console.log("e2e-core: tool loop (write_file) with approval");
{
  let asked = 0;
  const engine = new Engine({
    config,
    cwd,
    asker: async () => {
      asked++;
      return "allow";
    },
  });
  const evs = await run(engine, "WRITE_TEST please");
  const target = join(cwd, "tmp-e2e", "hello.txt");
  check("asker consulted for write", asked === 1, `asked=${asked}`);
  check("tool-start seen", byType(evs, "tool-start").length === 1);
  check("tool-end ok", byType(evs, "tool-end")[0]?.ok === true);
  check("file actually written", existsSync(target) && readFileSync(target, "utf8") === "hello claudeseek");
  check("model saw result → final text", byType(evs, "done")[0]?.text.includes("file written ok"));
  check("session has tool message", engine.session.messages.some((m) => m.role === "tool"));

  console.log("e2e-core: undo restores created file");
  const undo = engine.undo.undoLast();
  check("undo reports ok", undo.ok, undo.message);
  check("created file removed by undo", !existsSync(target));
}

console.log("e2e-core: plan mode denies writes");
{
  const engine = new Engine({ config: { ...config, agent: { ...config.agent, permission_mode: "plan" } }, cwd, asker: async () => "allow" });
  const evs = await run(engine, "WRITE_TEST again");
  const te = byType(evs, "tool-end")[0];
  check("write denied in plan mode", te?.denied === true, JSON.stringify(te));
}

console.log("e2e-core: headless (no asker) denies bash, hard-block stands");
{
  const engine = new Engine({ config, cwd, asker: null });
  const evs = await run(engine, "BASH_TEST");
  const te = byType(evs, "tool-end")[0];
  check("bash denied without approver", te?.denied === true);
}
{
  const { classifyCommand } = await import("../src/tools/shell.js");
  check("rm -rf / blocked", classifyCommand("rm -rf /") === "blocked");
  check("Remove-Item -Recurse C:\\ blocked", classifyCommand("Remove-Item -Recurse -Force C:\\ ") === "blocked");
  check("git status safe", classifyCommand("git status") === "safe");
  check("npm install needs approval", classifyCommand("npm install left-pad") === "needs-approval");
}

console.log("e2e-core: bash executes when allowed");
{
  const engine = new Engine({ config, cwd, asker: async () => "always" });
  const evs = await run(engine, "BASH_TEST");
  const te = byType(evs, "tool-end")[0];
  check("bash ran", te?.ok === true && /e2e-bash-ok/.test(te.output), te?.output);
  check("always-grant cached", engine.permissions.sessionAllow.size === 1);
}

console.log("e2e-core: compaction");
{
  const client = new DeepSeekClient({ ...config.llm, base_url: url });
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "user", content: `question ${i} ` + "x".repeat(400) });
    messages.push({ role: "assistant", content: `answer ${i} ` + "y".repeat(400) });
  }
  const before = estimateMessagesTokens(messages);
  const res = await compactMessages({ client, messages, contextWindow: 2000, threshold: 0.5, keepRecent: 6 });
  check("compaction fired", res.compacted === true);
  check("summary injected", messages.some((m) => m._meta?.compactBoundary && /SUMMARY/.test(m.content)));
  check("tokens reduced", estimateMessagesTokens(messages) < before);
}

console.log("e2e-core: glob/grep tools directly");
{
  const { globTool, grepTool } = await import("../src/tools/search.js");
  const g = await globTool.execute({ pattern: "**/*.txt" }, { cwd });
  check("glob finds nothing after undo", /No files matched/.test(g.output), g.output);
  const { writeFileTool } = await import("../src/tools/fs-tools.js");
  await writeFileTool.execute({ path: "sub/find-me.txt", content: "needle-here-42" }, { cwd });
  const g2 = await globTool.execute({ pattern: "**/*.txt" }, { cwd });
  check("glob finds file", /find-me\.txt/.test(g2.output));
  const r = await grepTool.execute({ pattern: "needle-here-\\d+" }, { cwd });
  check("grep finds content", /find-me\.txt:1/.test(r.output), r.output);
}

server.close();
rmSync(cwd, { recursive: true, force: true });
console.log(`\ne2e-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
