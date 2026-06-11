/**
 * config.js — layered configuration for claudeseek.
 *
 * Resolution order (first hit wins per key, later layers fill gaps):
 *   1. CLI flags (applied by the caller via applyOverrides)
 *   2. Environment variables (DEEPSEEK_API_KEY, CLAUDESEEK_MODEL, ...)
 *   3. ./.claudeseek/config.json   (workspace)
 *   4. ~/.claudeseek/config.json   (user)
 *   5. ~/.deepseek-cli/config.toml (existing WEIPING_WHALE/DeepSeek CLI install —
 *      claudeseek reuses the machine's DeepSeek credentials so no key re-entry)
 *   6. built-in defaults
 *
 * Zero dependencies: includes a small TOML-subset reader good enough for the
 * flat [section] key = "value" files the DeepSeek CLI family writes.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODELS = {
  "deepseek-v4-pro": {
    pricing: { cache_hit_usd: 0.07, cache_miss_usd: 0.56, output_usd: 1.68 },
    context_window: 128000,
    label: "V4 Pro — highest quality; architecture, debugging, hard coding",
  },
  "deepseek-v4-flash": {
    pricing: { cache_hit_usd: 0.014, cache_miss_usd: 0.14, output_usd: 0.28 },
    context_window: 128000,
    label: "V4 Flash — fast + economical; great default for agent work",
  },
};

/** Alias → { model, thinking? }. Mirrors the WEIPING_WHALE naming family. */
export const MODEL_ALIASES = {
  pro: { model: "deepseek-v4-pro" },
  flash: { model: "deepseek-v4-flash" },
  "v4-pro": { model: "deepseek-v4-pro" },
  "v4-flash": { model: "deepseek-v4-flash" },
  chat: { model: "deepseek-v4-flash", thinking: "disabled" },
  reasoner: { model: "deepseek-v4-pro", thinking: "enabled" },
  "deepseek-chat": { model: "deepseek-v4-flash", thinking: "disabled" },
  "deepseek-reasoner": { model: "deepseek-v4-pro", thinking: "enabled" },
  auto: { model: "auto" },
};

export const DEFAULTS = {
  llm: {
    provider: "deepseek", // deepseek | openai (OpenAI-compatible relay)
    model: "deepseek-v4-flash",
    api_key: "",
    api_key_env: "DEEPSEEK_API_KEY",
    api_key_source: "missing",
    base_url: "https://api.deepseek.com",
    temperature: 0.3,
    max_tokens: 8192,
    request_timeout_ms: 180000,
    thinking: "auto", // auto | enabled | disabled
    reasoning_effort: "high", // high | max
    default_headers: {},
  },
  agent: {
    max_iterations: 60,
    permission_mode: "default", // default | acceptEdits | bypassPermissions | plan
    compact_threshold: 0.75, // fraction of context window before auto-compact
  },
  server: { port: 3618, open: false },
  subagents: { max_depth: 2, max_iterations: 20 },
  memory: { agentmemory_url: "http://localhost:3111", enabled: true },
  mcp_servers: {},
  pricing: {},
};

export function userDir() {
  return join(homedir(), ".claudeseek");
}

export function ensureUserDirs() {
  for (const d of ["", "sessions", "undo", "skills", "memory-outbox"]) {
    mkdirSync(join(userDir(), d), { recursive: true });
  }
}

/** Tiny TOML subset reader: [section] / key = value (string|number|bool). */
export function parseTomlSubset(raw) {
  const out = {};
  let section = out;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sec) {
      section = {};
      const parts = sec[1].split(".");
      let cur = out;
      for (let i = 0; i < parts.length; i++) {
        if (i === parts.length - 1) cur[parts[i]] = cur[parts[i]] || section;
        else cur = cur[parts[i]] = cur[parts[i]] || {};
      }
      section = parts.reduce((acc, p) => acc[p], out);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let [, key, val] = kv;
    if (val.startsWith('"""')) continue; // skip multi-line strings (system prompts etc.)
    const hash = findCommentStart(val);
    if (hash >= 0) val = val.slice(0, hash).trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) section[key] = val.slice(1, -1);
    else if (val === "true" || val === "false") section[key] = val === "true";
    else if (!Number.isNaN(Number(val))) section[key] = Number(val);
    else section[key] = val;
  }
  return out;
}

function findCommentStart(val) {
  let inStr = false;
  let quote = "";
  for (let i = 0; i < val.length; i++) {
    const ch = val[i];
    if (inStr) {
      if (ch === quote) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
    } else if (ch === "#") {
      return i;
    }
  }
  return -1;
}

function deepMerge(target, source) {
  for (const key of Object.keys(source || {})) {
    const sv = source[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && typeof target[key] === "object" && target[key]) {
      deepMerge(target[key], sv);
    } else if (sv !== undefined) {
      target[key] = sv;
    }
  }
  return target;
}

function readJsonIf(path) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`claudeseek: ignoring malformed config ${path}: ${err.message}\n`);
  }
  return null;
}

export function loadConfig(cwd = process.cwd()) {
  const config = structuredClone(DEFAULTS);
  const sources = [];

  // 5) existing DeepSeek CLI installs (key + endpoint reuse, lowest data layer)
  for (const legacy of [
    join(homedir(), ".weiping-whale", "config.toml"),
    join(homedir(), ".deepseek-cli", "config.toml"),
  ]) {
    if (!existsSync(legacy)) continue;
    try {
      const t = parseTomlSubset(readFileSync(legacy, "utf8"));
      if (t.llm) {
        const { base_url, api_key_env, temperature } = t.llm;
        deepMerge(config.llm, { base_url, api_key_env, temperature });
        sources.push(`legacy:${legacy}`);
      }
      break;
    } catch {
      /* unreadable legacy config is non-fatal */
    }
  }

  // 4) user config, 3) workspace config
  for (const p of [join(userDir(), "config.json"), join(cwd, ".claudeseek", "config.json")]) {
    const j = readJsonIf(p);
    if (j) {
      deepMerge(config, j);
      sources.push(p);
    }
  }

  // 2) environment
  const envKey = process.env[config.llm.api_key_env || "DEEPSEEK_API_KEY"] || process.env.DEEPSEEK_API_KEY;
  if (envKey) {
    config.llm.api_key = envKey;
    config.llm.api_key_source = `env:${config.llm.api_key_env || "DEEPSEEK_API_KEY"}`;
  } else if (config.llm.api_key) {
    config.llm.api_key_source = "config";
  }
  if (process.env.DEEPSEEK_BASE_URL) config.llm.base_url = process.env.DEEPSEEK_BASE_URL;
  if (process.env.CLAUDESEEK_MODEL) applyModelAlias(config, process.env.CLAUDESEEK_MODEL);
  if (process.env.CLAUDESEEK_PERMISSION_MODE) config.agent.permission_mode = process.env.CLAUDESEEK_PERMISSION_MODE;

  // Provider selection. `CLAUDESEEK_PROVIDER=<name>` activates a named provider
  // from config.providers (or a built-in), swapping endpoint/key/model/headers.
  if (process.env.CLAUDESEEK_PROVIDER) {
    activateProvider(config, process.env.CLAUDESEEK_PROVIDER);
  } else if (config.llm.provider === "openai" && !config.llm.api_key && process.env.OPENAI_API_KEY) {
    config.llm.api_key = process.env.OPENAI_API_KEY;
    config.llm.api_key_source = "env:OPENAI_API_KEY";
  }

  config.llm.base_url = String(config.llm.base_url || "").replace(/\/+$/, "");
  config._sources = sources;
  return config;
}

/**
 * Switch the active LLM endpoint. Looks up `name` in config.providers first,
 * then a small built-in table. A provider entry is {provider, base_url,
 * api_key_env?, model?, default_headers?}. Keeps DeepSeek as the default while
 * letting the user point claudeseek at an OpenAI-compatible relay.
 */
export function activateProvider(config, name) {
  const key = String(name || "").trim().toLowerCase();
  const builtin = {
    deepseek: { provider: "deepseek", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY", model: "deepseek-v4-flash" },
    // Generic OpenAI-compatible relay: reads endpoint/key from env so no secret lives in code.
    relay: {
      provider: "openai",
      base_url: process.env.CLAUDESEEK_RELAY_BASE_URL || process.env.OPENAI_BASE_URL || "",
      api_key_env: "OPENAI_API_KEY",
      model: process.env.CLAUDESEEK_RELAY_MODEL || "gpt-5.5",
      default_headers: { "User-Agent": "curl/8.7.1" },
    },
  };
  const p = (config.providers && config.providers[key]) || builtin[key];
  if (!p) return config;
  config.llm.provider = p.provider || config.llm.provider;
  if (p.base_url) config.llm.base_url = p.base_url;
  if (p.model) config.llm.model = p.model;
  if (p.default_headers) config.llm.default_headers = p.default_headers;
  if (p.api_key) {
    config.llm.api_key = p.api_key;
    config.llm.api_key_source = `provider:${key}`;
  } else if (p.api_key_env && process.env[p.api_key_env]) {
    config.llm.api_key = process.env[p.api_key_env];
    config.llm.api_key_source = `env:${p.api_key_env}`;
  }
  return config;
}

export function applyModelAlias(config, input) {
  const alias = MODEL_ALIASES[String(input || "").trim().toLowerCase()];
  if (alias) {
    config.llm.model = alias.model;
    if (alias.thinking) config.llm.thinking = alias.thinking;
  } else if (input) {
    config.llm.model = String(input).trim();
  }
  return config;
}

export function resolveModelName(input) {
  const alias = MODEL_ALIASES[String(input || "").trim().toLowerCase()];
  return alias ? alias.model : String(input || "").trim();
}

export function pricingFor(config, model) {
  return (
    config.pricing?.[model] ||
    MODELS[model]?.pricing || { cache_hit_usd: 0.07, cache_miss_usd: 0.56, output_usd: 1.68 }
  );
}

export function contextWindowFor(model) {
  return MODELS[model]?.context_window || 128000;
}

export function validateConfig(config) {
  const checks = [];
  const add = (level, code, message) => checks.push({ level, code, message });
  add(
    config.llm.api_key ? "ok" : "error",
    "auth.api_key",
    config.llm.api_key
      ? `API key found (${config.llm.api_key_source})`
      : `No API key. Set ${config.llm.api_key_env || "DEEPSEEK_API_KEY"} or llm.api_key in ~/.claudeseek/config.json`
  );
  let host = "invalid-url";
  try {
    host = new URL(config.llm.base_url).host;
  } catch {
    /* keep invalid-url */
  }
  add(host !== "invalid-url" ? "ok" : "error", "llm.base_url", `endpoint host: ${host}`);
  add(config.agent.max_iterations >= 1 ? "ok" : "error", "agent.max_iterations", `max_iterations=${config.agent.max_iterations}`);
  const mode = config.agent.permission_mode;
  add(
    ["default", "acceptEdits", "bypassPermissions", "plan"].includes(mode) ? "ok" : "error",
    "agent.permission_mode",
    `permission_mode=${mode}`
  );
  return checks;
}
