/**
 * test-home.mjs — point HOME / USERPROFILE at a throwaway directory so tests
 * never read or write the real ~/.claudeseek (sessions, undo, config).
 * os.homedir() reads these variables on every call, so setting them before the
 * code under test runs is enough for both in-process and spawned tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolateHome(prefix = "cseek-home-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
