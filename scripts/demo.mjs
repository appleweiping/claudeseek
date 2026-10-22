/**
 * demo.mjs — try claudeseek without an API key (`npm run demo`).
 *
 * Starts the scripted fake server from fake-deepseek.mjs, makes a scratch
 * workspace containing greet.js with a typo, and drives the real REPL through
 * one turn. The model's replies are canned; the tool calls, the approval
 * prompts, the file edit and the command output are real.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFake } from "./fake-deepseek.mjs";
import { isolateHome } from "./test-home.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = isolateHome("cseek-demo-home-");
const ws = mkdtempSync(join(tmpdir(), "cseek-demo-"));
writeFileSync(join(ws, "greet.js"), 'console.log("Helo, world!");\n');
const { server, url } = await startFake();

// Each step waits for a pattern in the output, then types a line.
const steps = [
  { waitFor: /❯ $/, type: "fix the typo in greet.js" },
  { waitFor: /allow\? \S.*$/, type: "y" },
  { waitFor: /allow\? \S.*$/, type: "y" },
  { waitFor: /❯ $/, type: "/quit" },
];

const child = spawn(process.execPath, [join(root, "bin", "claudeseek.js"), "--cwd", ws], {
  env: { ...process.env, DEEPSEEK_API_KEY: "sk-demo", DEEPSEEK_BASE_URL: url },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let step = 0;
const timer = setTimeout(() => {
  process.stderr.write("\n[demo] timed out\n");
  child.kill();
}, 60000);

child.stdout.on("data", (d) => {
  const s = d.toString();
  process.stdout.write(s);
  buf += s;
  const next = steps[step];
  if (next && next.waitFor.test(buf)) {
    step++;
    buf = "";
    // stdin is a pipe, so nothing echoes what we type; print it ourselves.
    process.stdout.write(next.type + "\n");
    child.stdin.write(next.type + "\n");
  }
});

child.on("close", () => {
  clearTimeout(timer);
  server.close();
  process.stdout.write(`\n[demo] greet.js now contains: ${readFileSync(join(ws, "greet.js"), "utf8")}`);
  rmSync(ws, { recursive: true, force: true });
  home.cleanup();
});
