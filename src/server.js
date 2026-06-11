/**
 * server.js — claudeseek local Web UI server.
 * 127.0.0.1-only HTTP; token-gated JSON API; chat turns stream as NDJSON.
 * Approvals surface as `approval-request` events on the active stream and are
 * resolved via POST /api/approve — the same Permissions pipeline as the CLI.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { Engine } from "./engine.js";
import { MemoryBridge, recallBlock } from "./memory.js";
import { McpManager } from "./mcp.js";
import { listSessions, loadSession, createSession } from "./sessions.js";
import { PERMISSION_MODES } from "./permissions.js";
import { MODEL_ALIASES, resolveModelName, contextWindowFor } from "./config.js";
import { compactMessages } from "./compact.js";
import { c, wordmark } from "./theme.js";
import { VERSION } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startServer({ config, cwd, port = 3618, open = false, session = null, modelPref = null }) {
  const envToken = process.env.CLAUDESEEK_TOKEN;
  const token = envToken && /^[A-Za-z0-9_-]{8,128}$/.test(envToken) ? envToken : randomBytes(16).toString("hex");
  const memory = new MemoryBridge(config);
  const mcp = new McpManager(config);
  await mcp.startAll();

  /** @type {{res: import('http').ServerResponse}|null} */
  let activeStream = null;
  const pendingApprovals = new Map(); // id → {resolve, info}
  let firstTurn = !(session?.messages?.length);

  const asker = async ({ tool, kind, input, preview }) => {
    if (!activeStream) return "deny";
    const id = randomUUID();
    return await new Promise((resolve) => {
      pendingApprovals.set(id, { resolve, info: { tool, kind, preview } });
      writeEvent(activeStream.res, { type: "approval-request", id, tool, kind, preview, input: safeInput(input) });
    });
  };

  const engine = new Engine({
    config,
    cwd,
    session: session || undefined,
    asker,
    mcpTools: mcp.toolDescriptors(),
    modelPref: modelPref || undefined,
  });
  engine.events.on("side", (ev) => {
    if (activeStream && (ev.type === "subagent-start" || ev.type === "subagent-end")) {
      writeEvent(activeStream.res, ev);
    }
  });
  engine.events.on("todos", (todos) => {
    if (activeStream) writeEvent(activeStream.res, { type: "todos", todos });
  });

  const indexHtml = loadIndexHtml();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(indexHtml);
        return;
      }
      if (url.pathname === "/api/health") {
        return json(res, 200, { ok: true, name: "claudeseek", version: VERSION });
      }
      if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

      if (!authorized(req, url, token)) return json(res, 401, { error: "bad token" });

      if (req.method === "GET" && url.pathname === "/api/state") {
        const { tokens, window } = engine.contextEstimate();
        return json(res, 200, {
          version: VERSION,
          cwd,
          model: engine.modelPref,
          resolvedModel: resolveModelName(engine.modelPref === "auto" ? "flash" : engine.modelPref),
          models: Object.keys(MODEL_ALIASES),
          mode: engine.permissions.mode,
          modes: PERMISSION_MODES,
          busy: engine.busy,
          session: { id: engine.session.id, title: engine.session.title, messages: engine.session.messages.length },
          cost: engine.cost.snapshot(),
          costFooter: engine.cost.footer(),
          context: { tokens, window },
          skills: engine.skills,
          mcp: mcp.diagnostics(),
          memory: { base: memory.base, enabled: memory.enabled },
          todos: engine.session.todos || [],
        });
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return json(res, 200, { sessions: listSessions(30) });
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        return json(res, 200, { messages: engine.session.messages, todos: engine.session.todos || [] });
      }

      if (req.method === "POST" && url.pathname === "/api/session/new") {
        if (engine.busy) return json(res, 409, { error: "busy" });
        engine.session = createSession({ cwd, model: engine.modelPref });
        engine.turn = 0;
        firstTurn = true;
        return json(res, 200, { id: engine.session.id });
      }

      if (req.method === "POST" && url.pathname === "/api/session/open") {
        if (engine.busy) return json(res, 409, { error: "busy" });
        const body = await readBody(req);
        const s = loadSession(body.id);
        if (!s) return json(res, 404, { error: "session not found" });
        engine.session = s;
        engine.turn = s.messages.filter((m) => m.role === "user").length;
        firstTurn = false;
        return json(res, 200, { id: s.id, messages: s.messages.length });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        if (engine.busy) return json(res, 409, { error: "a turn is already running" });
        const body = await readBody(req);
        let text = String(body.message || "").trim();
        if (!text) return json(res, 400, { error: "empty message" });

        res.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        activeStream = { res };
        req.on("close", () => {
          if (activeStream?.res === res && engine.busy) engine.abort();
          rejectPending("stream closed");
        });

        if (firstTurn && config.memory?.auto_recall !== false) {
          const block = await recallBlock(memory, text);
          if (block) {
            writeEvent(res, { type: "recall-attached" });
            text += block;
          }
          firstTurn = false;
        }

        try {
          for await (const ev of engine.submit(text)) {
            writeEvent(res, thinEvent(ev));
          }
        } catch (err) {
          writeEvent(res, { type: "error", message: String(err?.message || err) });
        } finally {
          rejectPending("turn finished");
          activeStream = null;
          res.end();
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/approve") {
        const body = await readBody(req);
        const pending = pendingApprovals.get(body.id);
        if (!pending) return json(res, 404, { error: "no such approval" });
        pendingApprovals.delete(body.id);
        const decision = ["allow", "always", "deny"].includes(body.decision) ? body.decision : "deny";
        pending.resolve(decision);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/abort") {
        engine.abort();
        rejectPending("aborted");
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/model") {
        const body = await readBody(req);
        const m = String(body.model || "").toLowerCase();
        if (!MODEL_ALIASES[m]) return json(res, 400, { error: `unknown model: ${m}` });
        engine.setModel(m);
        return json(res, 200, { model: m });
      }

      if (req.method === "POST" && url.pathname === "/api/mode") {
        const body = await readBody(req);
        if (!PERMISSION_MODES.includes(body.mode)) return json(res, 400, { error: "unknown mode" });
        engine.setPermissionMode(body.mode);
        return json(res, 200, { mode: body.mode });
      }

      if (req.method === "POST" && url.pathname === "/api/undo") {
        const r = engine.undo.undoLast();
        return json(res, 200, r);
      }

      if (req.method === "POST" && url.pathname === "/api/compact") {
        if (engine.busy) return json(res, 409, { error: "busy" });
        const model = resolveModelName(engine.modelPref === "auto" ? "flash" : engine.modelPref);
        const r = await compactMessages({
          client: engine.client,
          messages: engine.session.messages,
          contextWindow: contextWindowFor(model),
          force: true,
        });
        return json(res, 200, r);
      }

      if (req.method === "POST" && url.pathname === "/api/remember") {
        const body = await readBody(req);
        if (!body.content) return json(res, 400, { error: "content required" });
        const r = await memory.remember({ content: String(body.content), type: "fact", project: "claudeseek", concepts: ["web-ui-note"] });
        return json(res, 200, r);
      }

      return json(res, 404, { error: "unknown endpoint" });
    } catch (err) {
      try {
        json(res, 500, { error: String(err?.message || err) });
      } catch {
        /* response already started */
      }
    }
  });

  function rejectPending(reason) {
    for (const [id, p] of pendingApprovals) {
      p.resolve("deny");
      pendingApprovals.delete(id);
    }
    void reason;
  }

  await new Promise((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(port, "127.0.0.1", resolveP);
  });

  const urlWithToken = `http://127.0.0.1:${port}/?token=${token}`;
  process.stdout.write(
    `\n  ${wordmark()} ${c.dim("web ui")}\n\n` +
      `  ${c.bold(urlWithToken)}\n` +
      `  ${c.dim(`cwd ${cwd} · model ${engine.modelPref} · mode ${engine.permissions.mode}`)}\n` +
      `  ${c.dim("Ctrl+C stops the server. The token changes each start (pin with CLAUDESEEK_TOKEN).")}\n\n`
  );
  if (open) {
    // execFile with arg arrays — no shell string interpolation.
    if (process.platform === "win32") execFile("cmd.exe", ["/c", "start", "", urlWithToken], () => {});
    else if (process.platform === "darwin") execFile("open", [urlWithToken], () => {});
    else execFile("xdg-open", [urlWithToken], () => {});
  }
  process.on("SIGINT", () => {
    mcp.stopAll();
    server.close();
    process.exit(0);
  });
  return { server, port, token, engine };
}

function loadIndexHtml() {
  for (const p of [join(__dirname, "..", "public", "index.html")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "<h1>claudeseek: public/index.html missing</h1>";
}

function authorized(req, url, token) {
  const provided = req.headers["x-claudeseek-token"] || url.searchParams.get("token") || "";
  const a = Buffer.from(String(provided));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function writeEvent(res, ev) {
  try {
    res.write(JSON.stringify(ev) + "\n");
  } catch {
    /* client went away; abort path handles cleanup */
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolveP, rejectP) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        rejectP(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      try {
        resolveP(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        resolveP({});
      }
    });
    req.on("error", rejectP);
  });
}

function thinEvent(ev) {
  if (ev.type === "tool-end") {
    return { ...ev, output: String(ev.output || "").slice(0, 8000) };
  }
  return ev;
}

function safeInput(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 4000 ? { _truncated: true, preview: s.slice(0, 1000) } : input;
  } catch {
    return {};
  }
}
