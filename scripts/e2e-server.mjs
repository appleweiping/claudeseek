/**
 * e2e-server.mjs — Web UI server: auth, state, NDJSON chat stream, browser
 * approval round-trip, session APIs. Runs fully offline against the fake API.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "./fake-deepseek.mjs";

const { server: fake, url } = await startFake();
process.env.DEEPSEEK_API_KEY = "sk-fake";
process.env.DEEPSEEK_BASE_URL = url;
process.env.CLAUDESEEK_DISABLE_AGENTMEMORY = "1";
process.env.CLAUDESEEK_TOKEN = "e2e-test-token-123";

const { loadConfig } = await import("../src/config.js");
const { startServer } = await import("../src/server.js");

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

const cwd = mkdtempSync(join(tmpdir(), "cseek-srv-"));
const config = loadConfig(cwd);
const port = 3690 + Math.floor(Math.random() * 200);
const { server, token } = await startServer({ config, cwd, port, open: false });
const base = `http://127.0.0.1:${port}`;
const T = (p) => `${base}${p}${p.includes("?") ? "&" : "?"}token=${token}`;

console.log("e2e-server: health + auth");
{
  const h = await (await fetch(`${base}/api/health`)).json();
  check("health ok", h.ok === true);
  const unauth = await fetch(`${base}/api/state`);
  check("state rejects without token", unauth.status === 401);
  const auth = await fetch(T("/api/state"));
  check("state with token", auth.status === 200);
  const ui = await fetch(base + "/");
  const html = await ui.text();
  check("index.html served", ui.status === 200 && /claudeseek/.test(html));
}

console.log("e2e-server: chat stream (PING)");
{
  const res = await fetch(T("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "PING" }),
  });
  const text = await res.text();
  const events = text.trim().split("\n").map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  check("ndjson streams", events.length > 3);
  check("done has pong", events.find((e) => e.type === "done")?.text.includes("pong"), types.join(","));
}

console.log("e2e-server: approval round-trip (WRITE_TEST)");
{
  const target = join(cwd, "tmp-e2e", "hello.txt");
  const chatP = (async () => {
    const res = await fetch(T("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "WRITE_TEST" }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const events = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        events.push(ev);
        if (ev.type === "approval-request") {
          // browser-style approval
          fetch(T("/api/approve"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: ev.id, decision: "allow" }),
          });
        }
      }
    }
    return events;
  })();
  const events = await chatP;
  const approval = events.find((e) => e.type === "approval-request");
  check("approval-request emitted", !!approval, JSON.stringify(events.map((e) => e.type)));
  check("tool executed after approve", events.find((e) => e.type === "tool-end")?.ok === true);
  check("file written via web approval", existsSync(target) && readFileSync(target, "utf8") === "hello claudeseek");
  check("final text arrived", events.find((e) => e.type === "done")?.text.includes("file written ok"));
}

console.log("e2e-server: state/sessions/undo/history");
{
  const st = await (await fetch(T("/api/state"))).json();
  check("state has cost", st.cost.requests >= 2, JSON.stringify(st.cost));
  check("context estimate sane", st.context.tokens > 0 && st.context.window >= 100000);
  const hist = await (await fetch(T("/api/history"))).json();
  check("history has tool message", hist.messages.some((m) => m.role === "tool"));
  const undo = await (await fetch(T("/api/undo"), { method: "POST" })).json();
  check("undo via api", undo.ok === true, undo.message);
  const sessions = await (await fetch(T("/api/sessions"))).json();
  check("sessions listed", Array.isArray(sessions.sessions) && sessions.sessions.length >= 1);
  const nw = await (await fetch(T("/api/session/new"), { method: "POST" })).json();
  check("new session", typeof nw.id === "string");
  const model = await (await fetch(T("/api/model"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "pro" }) })).json();
  check("model switch", model.model === "pro");
  const mode = await (await fetch(T("/api/mode"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "acceptEdits" }) })).json();
  check("mode switch", mode.mode === "acceptEdits");
}

server.close();
fake.close();
rmSync(cwd, { recursive: true, force: true });
console.log(`\ne2e-server: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
