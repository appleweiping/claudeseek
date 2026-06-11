/**
 * e2e-cli.mjs — headless CLI (-p/--json) + doctor against the fake API.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFake } from "./fake-deepseek.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { server, url } = await startFake();
const cwd = mkdtempSync(join(tmpdir(), "cseek-cli-"));

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

function runCli(args, timeoutMs = 30000) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [join(root, "bin", "claudeseek.js"), ...args], {
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "sk-fake",
        DEEPSEEK_BASE_URL: url,
        CLAUDESEEK_DISABLE_AGENTMEMORY: "1",
        NO_COLOR: "1",
      },
      cwd,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, out, err });
    });
  });
}

console.log("e2e-cli: --version / --help");
{
  const v = await runCli(["--version"]);
  check("version exits 0", v.code === 0 && /claudeseek v1\./.test(v.out), v.out + v.err);
  const h = await runCli(["--help"]);
  check("help shows usage", h.code === 0 && /usage/.test(h.out));
}

console.log("e2e-cli: headless -p PING");
{
  const r = await runCli(["-p", "PING"]);
  check("prints pong", r.code === 0 && /pong from fake model/.test(r.out), r.out + r.err);
}

console.log("e2e-cli: headless --json event stream");
{
  const r = await runCli(["-p", "PING", "--json"]);
  const lines = r.out.trim().split("\n").filter((l) => l.startsWith("{"));
  const types = lines.map((l) => JSON.parse(l).type);
  check("json events parse", lines.length > 3, r.out.slice(0, 300));
  check("has turn-start/text/done", ["turn-start", "text", "done"].every((t) => types.includes(t)), types.join(","));
}

console.log("e2e-cli: headless write denied without --yolo, allowed with --yolo");
{
  const denied = await runCli(["-p", "WRITE_TEST", "--json"]);
  const evs = denied.out.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const te = evs.find((e) => e.type === "tool-end");
  check("denied headless", te?.denied === true, JSON.stringify(te));

  const allowed = await runCli(["-p", "WRITE_TEST", "--yolo", "--json"]);
  const evs2 = allowed.out.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const te2 = evs2.find((e) => e.type === "tool-end");
  check("yolo allows write", te2?.ok === true, JSON.stringify(te2 || allowed.err.slice(0, 200)));
}

console.log("e2e-cli: --doctor --json");
{
  const r = await runCli(["--doctor", "--json"]);
  let doc = null;
  try {
    doc = JSON.parse(r.out);
  } catch {
    /* fallthrough */
  }
  check("doctor json parses", !!doc, r.out.slice(0, 200));
  const reach = doc?.checks?.find((c) => c.code === "llm.reachable");
  check("endpoint reachable via fake", reach?.level === "ok", JSON.stringify(reach));
  check("doctor exit 0", r.code === 0);
}

server.close();
rmSync(cwd, { recursive: true, force: true });
console.log(`\ne2e-cli: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
