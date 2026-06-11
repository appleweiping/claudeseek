/**
 * repl.js — the claudeseek interactive terminal.
 * Streaming render, slash commands, inline approvals, live cost footer.
 */
import readline from "node:readline";
import { Engine } from "./engine.js";
import { c, wordmark, glyph } from "./theme.js";
import { PERMISSION_MODES } from "./permissions.js";
import { MODEL_ALIASES, MODELS, contextWindowFor, resolveModelName } from "./config.js";
import { listSessions, loadSession } from "./sessions.js";
import { MemoryBridge, recallBlock } from "./memory.js";
import { McpManager } from "./mcp.js";
import { loadSkill } from "./skills.js";
import { formatTokens } from "./cost.js";
import { compactMessages } from "./compact.js";
import { VERSION } from "./version.js";

const HELP = `
${c.bold("Slash commands")}
  /help                 this help
  /model [name]         show or switch model (pro | flash | auto | reasoner | chat)
  /mode [m]             permission mode: default | acceptEdits | bypassPermissions | plan
  /cost                 session cost + cache hit ratio
  /context              context size estimate
  /compact              force context compaction
  /clear                start a fresh conversation (same session id)
  /undo                 revert the last turn's file changes
  /sessions             list recent sessions
  /resume <id>          load a previous session
  /skills               list discovered SKILL.md skills
  /skill <name>         inject a skill's content into the conversation
  /todos                show the agent's todo list
  /mcp                  MCP server status
  /memory               agentmemory status
  /remember <text>      save a note to agentmemory (tagged agent:claudeseek)
  /recall <query>       search agentmemory
  /quit | /exit         leave (Ctrl+C twice also works)

${c.bold("Keys")}  Ctrl+C aborts the running turn; at the prompt it asks to exit.
`;

export async function startRepl({ config, cwd, session = null, modelPref = null }) {
  const memory = new MemoryBridge(config);
  const mcp = new McpManager(config);
  await mcp.startAll();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const asker = async ({ tool, kind, input, preview }) => {
    process.stdout.write(
      `\n${c.yellow("◆ approval needed")} ${c.bold(tool)} ${c.dim(`(${kind})`)}\n  ${preview}\n`
    );
    while (true) {
      const a = (await ask(`  ${c.yellow("allow?")} ${c.dim("[y]es / [a]lways / [n]o")} `)).trim().toLowerCase();
      if (["y", "yes", ""].includes(a)) return "allow";
      if (["a", "always"].includes(a)) return "always";
      if (["n", "no"].includes(a)) return "deny";
    }
  };

  const engine = new Engine({
    config,
    cwd,
    session: session || undefined,
    asker,
    mcpTools: mcp.toolDescriptors(),
    modelPref: modelPref || undefined,
  });

  banner(engine, config, mcp);

  let firstTurn = engine.session.messages.length === 0;
  let sigintArmed = false;

  rl.on("SIGINT", () => {
    if (engine.busy) {
      engine.abort();
      process.stdout.write(`\n${c.red("✗ aborting turn…")}\n`);
      return;
    }
    if (sigintArmed) {
      shutdown(0);
    } else {
      sigintArmed = true;
      process.stdout.write(`\n${c.dim("(Ctrl+C again to exit)")}\n`);
      setTimeout(() => (sigintArmed = false), 2000);
      prompt();
    }
  });

  function shutdown(code) {
    try {
      mcp.stopAll();
    } catch {
      /* exiting anyway */
    }
    rl.close();
    process.exit(code);
  }

  function prompt() {
    rl.setPrompt(`${c.orange("❯")} `);
    rl.prompt(true);
  }

  async function runTurn(text) {
    if (firstTurn && config.memory?.auto_recall !== false) {
      const block = await recallBlock(memory, text);
      if (block) {
        process.stdout.write(c.dim("  ⌁ agentmemory recall attached\n"));
        text += block;
      }
      firstTurn = false;
    }

    let inReasoning = false;
    let spinnerTimer = startSpinner();
    const stopSpinner = () => {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
        process.stdout.write("\r\x1b[2K");
      }
    };

    try {
      for await (const ev of engine.submit(text)) {
        switch (ev.type) {
          case "route":
            stopSpinner();
            process.stdout.write(c.dim(`  ⌁ router → ${ev.model} (${ev.reason})\n`));
            spinnerTimer = startSpinner();
            break;
          case "reasoning":
            stopSpinner();
            if (!inReasoning) {
              process.stdout.write(c.gray("✻ thinking… "));
              inReasoning = true;
            }
            process.stdout.write(c.gray(compactWs(ev.text)));
            break;
          case "text":
            stopSpinner();
            if (inReasoning) {
              process.stdout.write("\n\n");
              inReasoning = false;
            }
            process.stdout.write(ev.text);
            break;
          case "tool-start":
            stopSpinner();
            if (inReasoning) {
              process.stdout.write("\n");
              inReasoning = false;
            }
            process.stdout.write(`\n${c.blue(glyph.dot)} ${c.bold(ev.name)}${c.dim(`(${ev.preview})`)}\n`);
            break;
          case "tool-end": {
            const first = String(ev.output || "").split("\n")[0].slice(0, 160);
            const mark = ev.denied ? c.yellow("denied") : ev.ok ? c.green("ok") : c.red("failed");
            process.stdout.write(`  ${c.dim(glyph.corner)} ${mark} ${c.dim(`${first} · ${ev.ms}ms`)}\n`);
            spinnerTimer = startSpinner();
            break;
          }
          case "compacted":
            stopSpinner();
            process.stdout.write(c.dim(`  ⌁ context compacted (${formatTokens(ev.est)} est → summary)\n`));
            spinnerTimer = startSpinner();
            break;
          case "error":
            stopSpinner();
            process.stdout.write(`\n${c.red(`✗ ${ev.message}`)}\n`);
            break;
          case "done":
            stopSpinner();
            break;
        }
      }
    } finally {
      stopSpinner();
    }
    process.stdout.write(`\n${c.dim(engine.cost.footer() + ` · ${engine.permissions.mode} · ${modelLabel(engine)}`)}\n\n`);
  }

  async function handleSlash(line) {
    const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch ((cmd || "").toLowerCase()) {
      case "help":
        process.stdout.write(HELP + "\n");
        return;
      case "model":
        if (!arg) {
          process.stdout.write(`current: ${c.bold(engine.modelPref)} → ${resolveModelName(engine.modelPref === "auto" ? "flash" : engine.modelPref)}\n`);
          for (const [alias, v] of Object.entries(MODEL_ALIASES)) {
            process.stdout.write(`  ${alias.padEnd(20)} ${c.dim(v.model + (v.thinking ? ` (${v.thinking})` : ""))}\n`);
          }
        } else if (MODEL_ALIASES[arg.toLowerCase()] || MODELS[arg]) {
          engine.setModel(arg.toLowerCase());
          process.stdout.write(`model → ${c.bold(arg)}\n`);
        } else {
          process.stdout.write(c.red(`unknown model: ${arg}\n`));
        }
        return;
      case "mode":
        if (!arg) {
          process.stdout.write(`permission mode: ${c.bold(engine.permissions.mode)} (${PERMISSION_MODES.join(" | ")})\n`);
        } else if (PERMISSION_MODES.includes(arg)) {
          engine.setPermissionMode(arg);
          process.stdout.write(`mode → ${c.bold(arg)}\n`);
        } else {
          process.stdout.write(c.red(`unknown mode: ${arg}\n`));
        }
        return;
      case "cost": {
        const s = engine.cost.snapshot();
        process.stdout.write(
          `${engine.cost.footer()}\n` +
            Object.entries(s.byModel)
              .map(([m, v]) => `  ${m}: ${v.requests} req · ${formatTokens(v.tokens)} tok · $${v.costUsd.toFixed(4)}`)
              .join("\n") +
            "\n"
        );
        return;
      }
      case "context": {
        const { tokens, window } = engine.contextEstimate();
        process.stdout.write(`~${formatTokens(tokens)} of ${formatTokens(window)} tokens (${Math.round((tokens / window) * 100)}%)\n`);
        return;
      }
      case "compact": {
        const model = resolveModelName(engine.modelPref === "auto" ? "flash" : engine.modelPref);
        const res = await compactMessages({
          client: engine.client,
          messages: engine.session.messages,
          contextWindow: contextWindowFor(model),
          force: true,
        });
        process.stdout.write(res.compacted ? c.green("compacted.\n") : c.dim("nothing worth compacting yet.\n"));
        return;
      }
      case "clear":
        engine.session.messages = [];
        engine.session.todos = [];
        process.stdout.write(c.dim("conversation cleared.\n"));
        return;
      case "undo": {
        const r = engine.undo.undoLast();
        process.stdout.write((r.ok ? c.green : c.dim)(r.message + "\n"));
        return;
      }
      case "sessions": {
        for (const s of listSessions(15)) {
          process.stdout.write(`  ${c.bold(s.id)} ${c.dim(`${s.messages} msgs · $${s.costUsd.toFixed(3)} · ${s.updated?.slice(0, 16)}`)}\n    ${s.title}\n`);
        }
        return;
      }
      case "resume": {
        const s = loadSession(arg);
        if (!s) {
          process.stdout.write(c.red(`session not found: ${arg}\n`));
          return;
        }
        engine.session = s;
        engine.turn = s.messages.filter((m) => m.role === "user").length;
        process.stdout.write(c.green(`resumed ${s.id} (${s.messages.length} messages)\n`));
        return;
      }
      case "skills":
        if (!engine.skills.length) process.stdout.write(c.dim("no SKILL.md skills found.\n"));
        for (const s of engine.skills) process.stdout.write(`  ${c.bold(s.name)} ${c.dim(s.description)}\n`);
        return;
      case "skill": {
        const s = loadSkill(cwd, arg);
        if (!s) {
          process.stdout.write(c.red(`skill not found: ${arg}\n`));
          return;
        }
        await runTurn(`Apply this skill to the conversation going forward.\n\n--- SKILL: ${s.name} ---\n${s.content}`);
        return;
      }
      case "todos": {
        const todos = engine.session.todos || [];
        if (!todos.length) process.stdout.write(c.dim("no todos.\n"));
        for (const t of todos) {
          const box = t.status === "completed" ? c.green("[x]") : t.status === "in_progress" ? c.yellow("[~]") : "[ ]";
          process.stdout.write(`  ${box} ${t.content}\n`);
        }
        return;
      }
      case "mcp": {
        const diag = mcp.diagnostics();
        if (!diag.length) process.stdout.write(c.dim("no MCP servers configured (mcp_servers in config.json).\n"));
        for (const d of diag) {
          process.stdout.write(`  ${c.bold(d.name)} ${d.status === "ready" ? c.green(d.status) : c.red(d.status)} ${c.dim(`${d.tools} tools${d.error ? " · " + d.error : ""}`)}\n`);
        }
        return;
      }
      case "memory": {
        const h = await memory.health();
        process.stdout.write(`agentmemory ${h.ok ? c.green("reachable") : c.red("unreachable")} ${c.dim(memory.base)}\n`);
        return;
      }
      case "remember": {
        if (!arg) {
          process.stdout.write(c.red("usage: /remember <text>\n"));
          return;
        }
        const r = await memory.remember({ content: arg, type: "fact", project: "claudeseek", concepts: ["manual-note"] });
        process.stdout.write(r.saved ? c.green("saved to agentmemory.\n") : c.yellow(`service down — queued to outbox: ${r.path}\n`));
        return;
      }
      case "recall": {
        const hits = await memory.search(arg || engine.session.title, 5);
        if (!hits.length) process.stdout.write(c.dim("no memories found.\n"));
        for (const h of hits) process.stdout.write(`  ${c.dim(`[${h.type || "fact"}]`)} ${h.content.slice(0, 200)}\n`);
        return;
      }
      case "quit":
      case "exit":
        shutdown(0);
        return;
      default:
        process.stdout.write(c.red(`unknown command: /${cmd} — try /help\n`));
    }
  }

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return prompt();
    rl.pause();
    try {
      if (text.startsWith("/")) await handleSlash(text);
      else await runTurn(text);
    } catch (err) {
      process.stdout.write(c.red(`\n✗ ${err?.message || err}\n`));
    }
    rl.resume();
    prompt();
  });

  prompt();
}

function banner(engine, config, mcp) {
  const mcpReady = mcp.diagnostics().filter((d) => d.status === "ready").length;
  const lines = [
    "",
    `  ${wordmark()} ${c.dim("v" + VERSION)}`,
    `  ${c.dim("Claude-grade agent architecture · DeepSeek V4 engine")}`,
    "",
    `  ${c.dim("cwd")}    ${engine.cwd}`,
    `  ${c.dim("model")}  ${engine.modelPref} ${c.dim(`· thinking ${config.llm.thinking} · mode ${engine.permissions.mode}`)}`,
    `  ${c.dim("key")}    ${config.llm.api_key ? c.green(config.llm.api_key_source) : c.red("missing — set DEEPSEEK_API_KEY")}`,
  ];
  if (engine.skills.length) lines.push(`  ${c.dim("skills")} ${engine.skills.length} discovered`);
  if (mcpReady) lines.push(`  ${c.dim("mcp")}    ${mcpReady} server(s) ready`);
  lines.push("", `  ${c.dim("/help for commands · Ctrl+C aborts a turn")}`, "");
  process.stdout.write(lines.join("\n") + "\n");
}

function startSpinner() {
  if (!process.stdout.isTTY) return null;
  let i = 0;
  return setInterval(() => {
    process.stdout.write(`\r${c.orange(glyph.spinnerFrames[i++ % glyph.spinnerFrames.length])} ${c.dim("working…")}  `);
  }, 90);
}

function compactWs(s) {
  return s.replace(/\n+/g, " ");
}

function modelLabel(engine) {
  return engine.modelPref === "auto" ? "auto-router" : resolveModelName(engine.modelPref);
}
