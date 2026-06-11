/**
 * api.js — DeepSeek chat-completions client (OpenAI-compatible, streaming).
 *
 * Design notes (ported from the Claude Code QueryEngine discipline):
 *  - One streaming code path; non-stream is just stream + join.
 *  - Tool-call deltas are assembled by index (DeepSeek splits name/arguments
 *    across chunks exactly like OpenAI).
 *  - reasoning_content deltas (V4 thinking) stream separately from content.
 *  - Retries with backoff on 429/5xx/network; AbortSignal cancels cleanly.
 *  - V4 thinking param: body.thinking = {type}, reasoning_effort when enabled,
 *    temperature must be omitted while thinking (API contract).
 */

export class DeepSeekError extends Error {
  constructor(message, { status, type, retryable } = {}) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
    this.type = type;
    this.retryable = !!retryable;
  }
}

export class DeepSeekClient {
  constructor(opts) {
    this.baseUrl = String(opts.base_url || "https://api.deepseek.com").replace(/\/+$/, "");
    this.apiKey = opts.api_key;
    this.model = opts.model;
    this.temperature = opts.temperature ?? 0.3;
    this.maxTokens = opts.max_tokens ?? 8192;
    this.timeoutMs = opts.request_timeout_ms ?? 180000;
    this.thinking = opts.thinking ?? "auto"; // auto|enabled|disabled
    this.reasoningEffort = opts.reasoning_effort ?? "high"; // high|max
    // provider shapes the request body: "deepseek" sends V4 thinking params;
    // "openai" speaks plain OpenAI chat-completions (relays, GPT, Claude proxies).
    this.provider = opts.provider === "openai" ? "openai" : "deepseek";
    this.extraHeaders = opts.default_headers || {};
  }

  /**
   * Stream one completion.
   * @param {object} req {messages, tools?, model?, thinking?, reasoningEffort?, maxTokens?, signal?}
   * @yields {{type:'text'|'reasoning', text:string} | {type:'tool_calls_done', tool_calls} |
   *          {type:'usage', usage} | {type:'finish', reason}}
   */
  async *stream(req) {
    const model = req.model || this.model;
    const thinking = normalizeThinking(req.thinking ?? this.thinking);
    const isDeepSeek = this.provider === "deepseek";
    const body = {
      model,
      messages: serializeMessages(req.messages, thinking, this.provider),
      max_tokens: req.maxTokens ?? this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = "auto";
    }
    if (isDeepSeek) {
      // DeepSeek V4 thinking contract: thinking object on; temperature off when thinking.
      body.thinking = { type: thinking };
      if (thinking === "enabled") body.reasoning_effort = req.reasoningEffort ?? this.reasoningEffort;
      else body.temperature = req.temperature ?? this.temperature;
    } else {
      // Plain OpenAI-compatible: just temperature; let the relay decide on reasoning.
      body.temperature = req.temperature ?? this.temperature;
    }

    const res = await this.#fetchRetry(`${this.baseUrl}/chat/completions`, body, req.signal);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // Tool-call assembly by stream index.
    const toolCalls = [];
    let usage = null;
    let finishReason = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            if (toolCalls.length) yield { type: "tool_calls_done", tool_calls: finalizeToolCalls(toolCalls) };
            if (usage) yield { type: "usage", usage };
            yield { type: "finish", reason: finishReason || "stop" };
            return;
          }
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          if (chunk.usage) usage = normalizeUsage(chunk.usage);
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          if (delta.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };
          if (delta.content) yield { type: "text", text: delta.content };
          for (const tc of delta.tool_calls || []) {
            const i = tc.index ?? 0;
            toolCalls[i] = toolCalls[i] || { id: "", name: "", arguments: "" };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    // Stream ended without [DONE] (proxy hiccup): still flush what we have.
    if (toolCalls.length) yield { type: "tool_calls_done", tool_calls: finalizeToolCalls(toolCalls) };
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: finishReason || "stop" };
  }

  /** Non-streaming convenience (compaction, sub-tasks, titles). */
  async complete(req) {
    let text = "";
    let reasoning = "";
    let toolCalls = [];
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    for await (const ev of this.stream(req)) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "reasoning") reasoning += ev.text;
      else if (ev.type === "tool_calls_done") toolCalls = ev.tool_calls;
      else if (ev.type === "usage") usage = ev.usage;
    }
    return { content: text || null, reasoning_content: reasoning || null, tool_calls: toolCalls, usage };
  }

  async #fetchRetry(url, body, signal, retries = 3) {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...this.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: combined,
        });
        if (res.ok) return res;
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        const err = new DeepSeekError(formatHttpError(res.status, text), {
          status: res.status,
          type: remoteErrorType(text),
          retryable,
        });
        if (!retryable || attempt === retries - 1) throw err;
        lastErr = err;
      } catch (err) {
        if (signal?.aborted) throw new DeepSeekError("request aborted", { type: "aborted" });
        if (err instanceof DeepSeekError) {
          if (!err.retryable || attempt === retries - 1) throw err;
          lastErr = err;
        } else {
          const msg =
            err?.name === "TimeoutError"
              ? `DeepSeek request timed out after ${this.timeoutMs}ms`
              : `DeepSeek network error: ${err?.message || err}`;
          if (attempt === retries - 1) throw new DeepSeekError(msg, { type: "network", retryable: true });
          lastErr = err;
        }
      }
      await sleep(1000 * (attempt + 1));
    }
    throw lastErr || new DeepSeekError("retries exhausted", { type: "network" });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeThinking(mode) {
  return mode === "auto" ? "enabled" : mode === "enabled" || mode === "disabled" ? mode : "enabled";
}

/**
 * DeepSeek requires assistant tool-call messages to carry reasoning_content
 * when thinking is on, and rejects reasoning_content when thinking is off.
 * OpenAI-compatible relays don't understand reasoning_content at all, so we
 * strip it entirely for that provider.
 */
function serializeMessages(messages, thinking, provider = "deepseek") {
  return messages.map((m) => {
    const s = { ...m };
    delete s._meta;
    if (provider !== "deepseek") {
      delete s.reasoning_content;
      return s;
    }
    if (thinking !== "disabled" && s.role === "assistant" && s.tool_calls?.length && s.reasoning_content == null) {
      s.reasoning_content = "";
    }
    if (s.reasoning_content == null || thinking === "disabled") delete s.reasoning_content;
    return s;
  });
}

function finalizeToolCalls(parts) {
  return parts
    .filter(Boolean)
    .map((p, i) => ({
      id: p.id || `call_${i}_${Date.now().toString(36)}`,
      type: "function",
      function: { name: p.name, arguments: p.arguments || "{}" },
    }));
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return { prompt_tokens: 0, completion_tokens: 0 };
  const usage = {
    prompt_tokens: Number(raw.prompt_tokens) || 0,
    completion_tokens: Number(raw.completion_tokens) || 0,
  };
  if (raw.prompt_cache_hit_tokens != null) usage.prompt_cache_hit_tokens = Number(raw.prompt_cache_hit_tokens) || 0;
  if (raw.prompt_cache_miss_tokens != null) usage.prompt_cache_miss_tokens = Number(raw.prompt_cache_miss_tokens) || 0;
  const cached = raw.prompt_tokens_details?.cached_tokens;
  if (usage.prompt_cache_hit_tokens == null && cached != null) {
    usage.prompt_cache_hit_tokens = Number(cached) || 0;
    usage.prompt_cache_miss_tokens = Math.max(0, usage.prompt_tokens - usage.prompt_cache_hit_tokens);
  }
  return usage;
}

function formatHttpError(status, bodyText) {
  const type = remoteErrorType(bodyText);
  const hint =
    status === 401
      ? " Check your API key."
      : status === 402
        ? " Payment required — the account is out of balance. Top up, or switch provider (CLAUDESEEK_PROVIDER=relay)."
        : status === 429
          ? " Rate limited — retry shortly."
          : status >= 500
            ? " Provider degraded — retry later."
            : "";
  return `LLM API HTTP ${status} (${type}).${hint}`;
}

function remoteErrorType(text) {
  if (!text?.trim()) return "empty_response";
  try {
    const data = JSON.parse(text);
    const remote = data?.error ?? data;
    return String(remote?.type ?? remote?.code ?? "provider_error").slice(0, 80);
  } catch {
    return "non_json_error_body";
  }
}
