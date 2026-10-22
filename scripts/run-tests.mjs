/**
 * run-tests.mjs — run the offline e2e suites one after another.
 *   node scripts/run-tests.mjs            all suites
 *   node scripts/run-tests.mjs core cli   a subset
 * Each suite starts its own fake DeepSeek server and uses a temp HOME.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const all = ["core", "cli", "server"];
const picked = process.argv.slice(2).length ? process.argv.slice(2) : all;

let failed = 0;
for (const name of picked) {
  if (!all.includes(name)) {
    console.error(`unknown suite: ${name} (expected one of ${all.join(", ")})`);
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [join(here, `e2e-${name}.mjs`)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
