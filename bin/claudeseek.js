#!/usr/bin/env node
import { main } from "../src/index.js";

main()
  .then((code) => {
    if (typeof code === "number" && code >= 0) {
      // exitCode + natural drain avoids a libuv async-handle assertion that
      // process.exit() can trigger on Windows while undici sockets settle.
      process.exitCode = code;
      setTimeout(() => process.exit(code), 5000).unref();
    }
    // negative → long-running mode (REPL / server) owns the lifecycle
  })
  .catch((err) => {
    process.stderr.write(`claudeseek fatal: ${err?.stack || err}\n`);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000).unref();
  });
