/**
 * index.js — claudeseek entrypoint.
 *
 *   claudeseek                  interactive REPL
 *   claudeseek -p "prompt"      headless one-shot (safe tools only; --yolo to allow all)
 *   claudeseek --serve          local Web UI at http://127.0.0.1:<port>
 *   claudeseek --doctor [--json] environment diagnostics
 *   claudeseek --last | --resume <id>
 *   flags: --model <m> --mode <m> --cwd <dir> --port <n> --open --yolo --json
 */
import { loadConfig, ensureUserDirs, applyModelAlias, validateConfig, MODEL_ALIASES } from "./config.js";
import { Engine } from "./engine.js";
import { loadSession, lastSessionId } from "./sessions.js";
import { MemoryBridge } from "./memory.js";
import { McpManager } from "./mcp.js";
import { VERSION, NAME, TAGLINE } from "./version.js";
import { c, wordmark } from "./theme.js";
import { resolve } from "node:path";

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.version) {
    process.stdout.write(`${NAME} v${VERSION}\n`);
    return 0;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  ensureUserDirs();
  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
  const config = loadConfig(cwd);
  if (args.model) applyModelAlias(config, args.model);
  if (args.mode) config.agent.permission_mode = args.mode;
  if (args.yolo) config.agent.permission_mode = "bypassPermissions";

  if (args.doctor) return await doctor(config, cwd, args.json);

  if (!config.llm.api_key && !args.doctor) {
    process.stderr.write(
      c.red(`No DeepSeek API key found. Set ${config.llm.api_key_env || "DEEPSEEK_API_KEY"} (or llm.api_key in ~/.claudeseek/config.json), then retry.\n`)
    );
    return 1;
  }

  let session = null;
  if (args.last) {
    const id = lastSessionId();
    if (id) session = loadSession(id);
  } else if (args.resume) {
    session = loadSession(args.resume);
    if (!session) {
      process.stderr.write(c.red(`session not found: ${args.resume}\n`));
      return 1;
    }
  }

  const modelPref = args.model ? args.model.toLowerCase() : config.llm.model === "auto" ? "auto" : null;

  if (args.serve) {
    const { startServer } = await import("./server.js");
    await startServer({ config, cwd, port: args.port || config.server.port, open: args.open ?? config.server.open, session, modelPref });
    return -1; // keep process alive
  }

  if (args.print != null) {
    return await headless({ config, cwd, prompt: args.print, json: args.json, session, modelPref });
  }

  const { startRepl } = await import("./repl.js");
  await startRepl({ config, cwd, session, modelPref });
  return -1; // REPL owns the lifecycle
}

async function headless({ config, cwd, prompt, json, session, modelPref }) {
  const mcp = new McpManager(config);
  await mcp.startAll();
  const engine = new Engine({
    config,
    cwd,
    session: session || undefined,
    mcpTools: mcp.toolDescriptors(),
    modelPref: modelPref || undefined,
    asker: null, // non-interactive: anything needing approval is denied unless --yolo
  });
  let final = "";
  let hadError = false;
  for await (const ev of engine.submit(prompt)) {
    if (json) process.stdout.write(JSON.stringify(thin(ev)) + "\n");
    if (ev.type === "done") final = ev.text;
    if (ev.type === "error" && !ev.aborted) hadError = true;
  }
  if (!json) process.stdout.write((final || "(no reply)") + "\n");
  mcp.stopAll();
  return hadError ? 1 : 0;
}

function thin(ev) {
  if (ev.type === "text" || ev.type === "reasoning") return ev;
  if (ev.type === "tool-end") return { ...ev, output: String(ev.output || "").slice(0, 2000) };
  return ev;
}

async function doctor(config, cwd, asJson) {
  const checks = validateConfig(config);
  // Endpoint reachability (models list endpoint is cheap + key-validating).
  try {
    const res = await fetch(`${config.llm.base_url}/models`, {
      headers: { Authorization: `Bearer ${config.llm.api_key}` },
      signal: AbortSignal.timeout(8000),
    });
    checks.push({
      level: res.ok ? "ok" : "error",
      code: "llm.reachable",
      message: res.ok ? `endpoint reachable (HTTP ${res.status})` : `endpoint returned HTTP ${res.status}`,
    });
  } catch (err) {
    checks.push({ level: "error", code: "llm.reachable", message: `endpoint unreachable: ${err?.message}` });
  }
  const memory = new MemoryBridge(config);
  const h = await memory.health();
  checks.push({
    level: h.ok ? "ok" : "warn",
    code: "memory.agentmemory",
    message: h.ok ? `agentmemory reachable at ${memory.base}` : `agentmemory not reachable (${h.reason || h.status}) — outbox fallback active`,
  });
  checks.push({ level: "ok", code: "llm.provider", message: `provider=${config.llm.provider} · model=${config.llm.model} · ${new URL(config.llm.base_url).host}` });
  checks.push({ level: "ok", code: "runtime.node", message: `node ${process.version} on ${process.platform}` });
  const mcpCount = Object.keys(config.mcp_servers || {}).length;
  checks.push({ level: "ok", code: "mcp.configured", message: `${mcpCount} MCP server(s) configured` });

  if (asJson) {
    process.stdout.write(JSON.stringify({ name: NAME, version: VERSION, cwd, checks }, null, 2) + "\n");
  } else {
    process.stdout.write(`\n  ${wordmark()} ${c.dim("doctor")}\n\n`);
    for (const ch of checks) {
      const mark = ch.level === "ok" ? c.green("✓") : ch.level === "warn" ? c.yellow("!") : c.red("✗");
      process.stdout.write(`  ${mark} ${ch.code.padEnd(24)} ${c.dim(ch.message)}\n`);
    }
    process.stdout.write("\n");
  }
  return checks.some((ch) => ch.level === "error") ? 1 : 0;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "-p":
      case "--print":
        args.print = argv[++i] ?? "";
        break;
      case "--serve":
        args.serve = true;
        break;
      case "--port":
        args.port = Number(argv[++i]);
        break;
      case "--open":
        args.open = true;
        break;
      case "--doctor":
        args.doctor = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--last":
      case "-c":
      case "--continue":
        args.last = true;
        break;
      case "--resume":
        args.resume = argv[++i];
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--mode":
        args.mode = argv[++i];
        break;
      case "--yolo":
      case "--dangerously-skip-permissions":
        args.yolo = true;
        break;
      case "--cwd":
        args.cwd = argv[++i];
        break;
      default:
        args._.push(a);
    }
  }
  // `claudeseek "do something"` == -p shorthand when stdin isn't a TTY use-case
  if (!args.print && args._.length && !args.serve && !args.doctor) {
    args.print = args._.join(" ");
  }
  return args;
}

function printHelp() {
  process.stdout.write(`
  ${wordmark()} v${VERSION} — ${TAGLINE}

  ${c.bold("usage")}
    claudeseek                        interactive REPL
    claudeseek -p "fix the bug"       headless one-shot
    claudeseek --serve [--open]       local Web UI (127.0.0.1)
    claudeseek --doctor [--json]      diagnostics
    claudeseek --last                 resume most recent session
    claudeseek --resume <id>          resume a session by id/prefix

  ${c.bold("flags")}
    -m, --model <m>     ${Object.keys(MODEL_ALIASES).slice(0, 6).join(" | ")} …
    --mode <m>          default | acceptEdits | bypassPermissions | plan
    --yolo              bypass permissions (careful)
    --port <n>          web UI port (default 3618)
    --cwd <dir>         workspace directory
    --json              JSONL events (with -p) / JSON (with --doctor)

  ${c.bold("provider")} default DeepSeek (国产 V4). Switch with CLAUDESEEK_PROVIDER=relay
            to use an OpenAI-compatible endpoint (OPENAI_BASE_URL + OPENAI_API_KEY).
  ${c.bold("config")}   ~/.claudeseek/config.json · env DEEPSEEK_API_KEY
  ${c.bold("docs")}     https://github.com/appleweiping/claudeseek
`);
}
