/**
 * engine.js — the claudeseek agent loop (a faithful DeepSeek port of Claude
 * Code's QueryEngine discipline):
 *
 *   submit(user) → assemble context → stream model → dispatch tool_calls
 *   through the permission pipeline → append tool results → loop until the
 *   model stops calling tools (or budget/turn caps hit) → persist session.
 *
 * All interaction (CLI, Web UI, headless) consumes the same event stream.
 */
import { EventEmitter } from "node:events";
import { DeepSeekClient } from "./api.js";
import { buildRegistry } from "./tools/index.js";
import { Permissions, previewOf } from "./permissions.js";
import { CostTracker } from "./cost.js";
import { buildSystemPrompt } from "./context.js";
import { compactMessages, estimateMessagesTokens } from "./compact.js";
import { contextWindowFor, resolveModelName } from "./config.js";
import { createSession, saveSession } from "./sessions.js";
import { UndoManager } from "./undo.js";
import { discoverSkills } from "./skills.js";
import { route } from "./router.js";

export class Engine {
  /**
   * @param {object} opts
   *   config        loaded config object
   *   cwd           workspace directory
   *   session?      resume an existing session object
   *   asker?        async approval callback (REPL / server / headless policy)
   *   mcpTools?     merged MCP tool descriptors
   *   depth?        sub-agent nesting depth
   *   onEvent?      optional side listener for todos etc.
   */
  constructor(opts) {
    this.config = opts.config;
    this.cwd = opts.cwd || process.cwd();
    this.depth = opts.depth || 0;
    this.events = new EventEmitter();
    this.modelPref = opts.modelPref || this.config.llm.model; // may be "auto"
    this.client = new DeepSeekClient(this.config.llm);
    this.permissions = new Permissions({
      mode: this.config.agent.permission_mode,
      cwd: this.cwd,
      asker: opts.asker || null,
    });
    this.cost = new CostTracker(this.config);
    this.session = opts.session || createSession({ cwd: this.cwd, model: this.modelPref });
    this.undo = new UndoManager(this.session.id);
    this.skills = safeDiscover(this.cwd);
    this.registry = buildRegistry({ includeTask: this.depth === 0, mcpTools: opts.mcpTools || [] });
    this.turn = countTurns(this.session.messages);
    this.abortController = null;
    this.busy = false;
    this._systemPrompt = null;
  }

  systemPrompt() {
    if (!this._systemPrompt) {
      this._systemPrompt = buildSystemPrompt({
        cwd: this.cwd,
        model: this.modelPref,
        permissionMode: this.permissions.mode,
        skills: this.skills,
        extraSystem: this.config.agent.system_prompt || "",
      });
    }
    return this._systemPrompt;
  }

  invalidateSystemPrompt() {
    this._systemPrompt = null;
  }

  setModel(pref) {
    this.modelPref = pref;
    this.session.model = pref;
    this.invalidateSystemPrompt();
  }

  setPermissionMode(mode) {
    this.permissions.setMode(mode);
    this.invalidateSystemPrompt();
  }

  abort() {
    this.abortController?.abort();
  }

  contextEstimate() {
    const model = resolveModelName(this.modelPref === "auto" ? "flash" : this.modelPref);
    return {
      tokens: estimateMessagesTokens(this.apiMessages()),
      window: contextWindowFor(model),
    };
  }

  apiMessages() {
    return [{ role: "system", content: this.systemPrompt() }, ...this.session.messages];
  }

  /** The agent loop. Yields events; see header for the protocol. */
  async *submit(userText, { signal } = {}) {
    if (this.busy) throw new Error("engine busy — one turn at a time");
    this.busy = true;
    this.abortController = new AbortController();
    const turnSignal = signal
      ? AbortSignal.any([signal, this.abortController.signal])
      : this.abortController.signal;

    this.turn += 1;
    this.undo.beginTurn(this.turn);
    const turn = this.turn;
    yield { type: "turn-start", turn };

    // Per-turn routing (model preference "auto" → keyword router).
    let model = resolveModelName(this.modelPref);
    let thinking = this.config.llm.thinking;
    let reasoningEffort = this.config.llm.reasoning_effort;
    if (this.modelPref === "auto") {
      const r = route({ lastUserMessage: userText, isSubagent: this.depth > 0 });
      model = r.model;
      thinking = r.thinking;
      reasoningEffort = r.reasoning_effort;
      yield { type: "route", model, thinking, reason: r.reason };
    }

    this.session.messages.push({ role: "user", content: String(userText) });
    if (!this.session.title) this.session.title = String(userText).split("\n")[0].slice(0, 80);

    let finalText = "";
    try {
      const maxIters = this.depth > 0 ? this.config.subagents.max_iterations : this.config.agent.max_iterations;
      for (let iter = 0; iter < maxIters; iter++) {
        if (turnSignal.aborted) throw new AbortError();

        // Auto-compaction before each request.
        const win = contextWindowFor(model);
        const result = await compactMessages({
          client: this.client,
          messages: this.session.messages,
          contextWindow: win,
          threshold: this.config.agent.compact_threshold,
        });
        if (result.compacted) yield { type: "compacted", est: result.est, limit: result.limit };

        let text = "";
        let reasoning = "";
        let toolCalls = [];
        for await (const ev of this.client.stream({
          model,
          thinking,
          reasoningEffort,
          messages: this.apiMessages(),
          tools: this.registry.specs(),
          signal: turnSignal,
        })) {
          if (ev.type === "text") {
            text += ev.text;
            yield { type: "text", text: ev.text };
          } else if (ev.type === "reasoning") {
            reasoning += ev.text;
            yield { type: "reasoning", text: ev.text };
          } else if (ev.type === "tool_calls_done") {
            toolCalls = ev.tool_calls;
          } else if (ev.type === "usage") {
            const delta = this.cost.record(model, ev.usage);
            this.session.usage.promptTokens += ev.usage.prompt_tokens || 0;
            this.session.usage.completionTokens += ev.usage.completion_tokens || 0;
            this.session.usage.costUsd += delta;
            yield { type: "usage", usage: ev.usage, costDelta: delta, costUsd: this.cost.state.costUsd, model };
          }
        }

        const assistantMsg = { role: "assistant", content: text || null };
        if (reasoning) assistantMsg.reasoning_content = reasoning;
        if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
        this.session.messages.push(assistantMsg);
        if (text) finalText = text;

        if (!toolCalls.length) break; // conversation settled

        for (const tc of toolCalls) {
          if (turnSignal.aborted) throw new AbortError();
          const name = tc.function?.name || "";
          let input = {};
          let parseError = null;
          try {
            input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch (err) {
            parseError = err;
          }
          yield { type: "tool-start", id: tc.id, name, input, preview: previewOf(name, input) };
          const result = parseError
            ? wrapResult(false, `Invalid JSON arguments for ${name}.`, Date.now(), input)
            : await this.#dispatchTool(name, input, turnSignal);
          this.session.messages.push({ role: "tool", tool_call_id: tc.id, content: result.outputForModel });
          yield {
            type: "tool-end",
            id: tc.id,
            name,
            ok: result.ok,
            denied: result.denied || false,
            output: result.outputForUser,
            ms: result.ms,
            input,
          };
        }
      }
    } catch (err) {
      if (err instanceof AbortError || turnSignal.aborted) {
        this.#healDanglingToolCalls("[aborted by user]");
        yield { type: "error", message: "turn aborted", aborted: true };
      } else {
        this.#healDanglingToolCalls(`[error: ${err?.message || err}]`);
        yield { type: "error", message: String(err?.message || err) };
      }
    } finally {
      this.busy = false;
      try {
        saveSession(this.session);
      } catch {
        /* persistence is best-effort */
      }
    }

    yield { type: "turn-end", turn };
    yield { type: "done", text: finalText };
  }

  async #dispatchTool(name, input, signal) {
    const started = Date.now();
    const tool = this.registry.get(name);
    if (!tool) return wrapResult(false, `Unknown tool: ${name}. Available: ${this.registry.list.map((t) => t.name).join(", ")}`, started, input);

    const decision = await this.permissions.check(tool, input, { signal });
    if (decision.behavior === "deny") {
      return {
        ...wrapResult(false, `Permission denied (${decision.reason}). Do not retry the same call; adapt or ask the user.`, started, input),
        denied: true,
      };
    }

    const ctx = {
      cwd: this.cwd,
      config: this.config,
      session: this.session,
      undo: this.undo,
      signal,
      depth: this.depth,
      events: this.events,
      fileState: null,
      spawnSubagent: this.depth === 0 ? (req) => this.#spawnSubagent(req, signal) : null,
    };
    try {
      const res = await tool.execute(input, ctx);
      const full = String(res.output ?? "");
      const forModel = full.length > 30000 ? full.slice(0, 30000) + "\n…(truncated)" : full;
      return {
        ok: !!res.ok,
        input,
        outputForModel: forModel || "(no output)",
        outputForUser: full.length > 4000 ? full.slice(0, 4000) + `\n…(${full.length} chars total)` : full,
        ms: Date.now() - started,
      };
    } catch (err) {
      return wrapResult(false, `Tool ${name} crashed: ${err?.message || err}`, started, input);
    }
  }

  async #spawnSubagent({ description, prompt, readonly }, signal) {
    const child = new Engine({
      config: this.config,
      cwd: this.cwd,
      depth: this.depth + 1,
      asker: this.permissions.asker, // approvals bubble to the same surface
      modelPref: this.modelPref === "auto" ? "auto" : this.modelPref,
    });
    child.registry = buildRegistry({ includeTask: false, readonly });
    child.permissions.mode = this.permissions.mode;
    child.permissions.sessionAllow = this.permissions.sessionAllow; // share grants
    this.events.emit("side", { type: "subagent-start", description });
    let text = "";
    let turns = 0;
    for await (const ev of child.submit(prompt, { signal })) {
      if (ev.type === "done") text = ev.text;
      if (ev.type === "usage") {
        this.cost.record(ev.model, ev.usage);
        this.session.usage.costUsd += ev.costDelta;
        turns++;
      }
      this.events.emit("side", { type: "subagent-event", description, ev: thin(ev) });
    }
    this.events.emit("side", { type: "subagent-end", description });
    return { ok: !!text, text, turns };
  }

  /** If the last assistant message has tool_calls without results, patch them. */
  #healDanglingToolCalls(note) {
    const msgs = this.session.messages;
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && last.tool_calls?.length) {
      const answered = new Set(
        msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)
      );
      for (const tc of last.tool_calls) {
        if (!answered.has(tc.id)) msgs.push({ role: "tool", tool_call_id: tc.id, content: note });
      }
    }
  }
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function wrapResult(ok, text, started, input) {
  return { ok, input, outputForModel: text, outputForUser: text, ms: Date.now() - started };
}

function countTurns(messages) {
  return (messages || []).filter((m) => m.role === "user" && !m._meta?.compactBoundary).length;
}

function thin(ev) {
  if (ev.type === "text" || ev.type === "reasoning") return { type: ev.type, len: ev.text?.length };
  const { output, ...rest } = ev;
  return rest;
}

function safeDiscover(cwd) {
  try {
    return discoverSkills(cwd);
  } catch {
    return [];
  }
}
