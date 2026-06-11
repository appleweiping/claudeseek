# claudeseek — project memory

This file is loaded into claudeseek's own system prompt when it runs inside this
repo (dogfooding). It is also the human contributor guide.

## What this is

A local-first coding agent: Claude Code's agent architecture re-implemented in
zero-dependency ESM JavaScript over the DeepSeek V4 API, with a terminal REPL
and a local Web UI. Sibling to WEIPING_WHALE (TS DeepSeek CLI); part of the
`D:\devtools` agent family.

## Hard rules for working in this repo

- **Zero runtime dependencies.** `package.json` has no `dependencies`. Use Node
  built-ins only (`node:*`). Never add a package to ship code.
- **One agent loop.** All surfaces (REPL, server, headless, sub-agents) consume
  `Engine.submit()`'s event stream. Do not fork conversation logic per surface.
- **Permissions are central.** Every tool call goes through `Permissions.check()`.
  New tools declare a `kind` (`read` | `write` | `shell` | `net` | `meta`); the
  pipeline decides. Never bypass it.
- **Provider neutrality.** `provider: "deepseek"` sends V4 thinking params;
  `"openai"` sends plain chat-completions. Keep both paths working — tests cover
  the DeepSeek shape; the relay shape must stay plain OpenAI.
- **Secrets never leave the box.** No keys in responses, commits, logs, or the
  browser. The server holds the key; the UI only holds the session token.
- **Tests must pass offline.** `npm test` runs against `scripts/fake-deepseek.mjs`
  with no network. Add a scenario there for any new tool/behavior.

## Layout

See README "Architecture". Entry: `bin/claudeseek.js` → `src/index.js` (arg
parse, doctor, headless, REPL, server) → `src/engine.js` (the loop).

## Memory protocol

Save durable findings to agentmemory (`http://localhost:3111`) with
`project: "claudeseek"` and concepts including `agent:claudeseek`. Follow
`D:\devtools\AGENT-MEMORY-PROTOCOL.md`. Don't store per-iteration logs.

## Adding a tool

1. Create `src/tools/<name>.js` exporting `{ name, kind, description,
   parameters (JSON Schema), async execute(input, ctx) }`.
2. Register it in `src/tools/index.js` `CORE_TOOLS`.
3. Add a scenario to `scripts/fake-deepseek.mjs` and an assertion to
   `scripts/e2e-core.mjs`.
4. `execute` returns `{ ok, output, meta? }`. Use `ctx.undo.snapshot(path)`
   before mutating files; `ctx.cwd` is the workspace root.
