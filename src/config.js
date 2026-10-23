/**
 * config.js — layered configuration for claudeseek.
 *
 * Resolution order (first hit wins per key, later layers fill gaps):
 *   1. CLI flags (applied by the caller)
 *   2. Environment variables (DEEPSEEK_API_KEY, CLAUDESEEK_MODEL, ...)
 *   3. ./.claudeseek/config.json   (workspace; only WORKSPACE_KEYS, see below)
 *   4. ~/.claudeseek/config.json   (user)
 *   5. built-in defaults
 *
 * claudeseek only reads its own config files and the environment. It never
 * looks inside other tools' config folders for keys or endpoints.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Prices are USD per 1M tokens, the peak-hour rates from
// https://api-docs.deepseek.com/quick_start/pricing as checked on 2026-10-22.
// Off-peak rates are half of these, so the cost footer is an upper bound.
// DeepSeek now calls the Flash model `deepseek-flash`; `deepseek-v4-flash`
// is still accepted and billed at the same price. Override with `pricing` in
// ~/.claudeseek/config.json when the page changes.
// context_window is how much claudeseek lets a conversation grow before it
// compacts, not the API limit (the page lists 1M for both models); compacting
// early keeps every request, and so its cost, smaller.
export const MODELS = {
  "deepseek-v4-pro": {
    pricing: { cache_hit_usd: 0.044, cache_miss_usd: 1.32, output_usd: 3.96 },
    context_window: 128000,
    label: "V4 Pro — highest quality; architecture, debugging, hard coding",
  },
  "deepseek-v4-flash": {
    pricing: { cache_hit_usd: 0.006, cache_miss_usd: 0.3, output_usd: 1.2 },
    context_window: 128000,
    label: "V4 Flash — fast + economical; great default for agent work",
  },
};

/** Alias → { model, thinking? }. */
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
  memory: { agentmemory_url: "http://localhost:3111", enabled: false }, // optional agentmemory server
  mcp_servers: {},
  pricing: {},
  trusted_workspaces: [], // folders whose .claudeseek/config.json is read in full
};

// A cloned repository can ship its own .claudeseek/config.json, and claudeseek
// reads it as soon as it starts in that folder. Only these keys are taken from
// it: they change how the model answers, not which programs claudeseek starts
// or where it sends your API key. Endpoints, keys, providers, MCP servers and
// the memory URL come from ~/.claudeseek/config.json, unless that file lists
// the folder under trusted_workspaces.
export const WORKSPACE_KEYS = {
  llm: ["model", "thinking", "reasoning_effort", "temperature", "max_tokens"],
  agent: ["compact_threshold", "permission_mode"],
};
// A workspace may make the permission mode stricter, never looser.
const WORKSPACE_MODES = ["default", "plan"];

export function userDir() {
  return join(homedir(), ".claudeseek");
}

export function ensureUserDirs() {
  for (const d of ["", "sessions", "undo", "skills", "memory-outbox"]) {
    mkdirSync(join(userDir(), d), { recursive: true });
  }
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

  // 4) user config
  const userPath = join(userDir(), "config.json");
  const user = readJsonIf(userPath);
  if (user) {
    deepMerge(config, user);
    sources.push(userPath);
  }

  // 3) workspace config: the safe subset, or all of it if the user trusts the folder
  const wsPath = join(cwd, ".claudeseek", "config.json");
  const ws = samePath(wsPath, userPath) ? null : readJsonIf(wsPath);
  config._workspace_ignored = [];
  if (ws) {
    if (isTrustedWorkspace(config, cwd)) {
      deepMerge(config, ws);
    } else {
      const { kept, ignored } = pickWorkspaceKeys(ws);
      deepMerge(config, kept);
      config._workspace_ignored = ignored;
      if (ignored.length) {
        process.stderr.write(
          `claudeseek: ignoring ${ignored.join(", ")} in ${wsPath}. ` +
            `Add this folder to trusted_workspaces in ~/.claudeseek/config.json to use them.\n`
        );
      }
    }
    sources.push(wsPath);
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

/** Split a workspace config into the keys we take and the ones we skip. */
export function pickWorkspaceKeys(json) {
  const kept = {};
  const ignored = [];
  for (const [section, value] of Object.entries(json || {})) {
    if (section === "//") continue; // comment key, as in config.example.json
    const allowed = WORKSPACE_KEYS[section];
    if (!allowed || !value || typeof value !== "object" || Array.isArray(value)) {
      ignored.push(section);
      continue;
    }
    for (const [key, v] of Object.entries(value)) {
      if (key === "//") continue;
      const ok =
        allowed.includes(key) && !(section === "agent" && key === "permission_mode" && !WORKSPACE_MODES.includes(v));
      if (ok) (kept[section] ||= {})[key] = v;
      else ignored.push(`${section}.${key}`);
    }
  }
  return { kept, ignored };
}

function normPath(p) {
  const abs = resolve(String(p).replace(/^~(?=$|[\\/])/, homedir()));
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function samePath(a, b) {
  return normPath(a) === normPath(b);
}

function isTrustedWorkspace(config, cwd) {
  const list = Array.isArray(config.trusted_workspaces) ? config.trusted_workspaces : [];
  return list.some((p) => typeof p === "string" && p && samePath(p, cwd));
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
  // Unknown model names are priced like Pro so the estimate errs high.
  return config.pricing?.[model] || MODELS[model]?.pricing || MODELS["deepseek-v4-pro"].pricing;
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
  if (config._workspace_ignored?.length) {
    add("warn", "workspace.config", `ignored ${config._workspace_ignored.join(", ")} (folder not in trusted_workspaces)`);
  }
  return checks;
}
