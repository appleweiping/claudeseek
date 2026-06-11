/**
 * cost.js — live cost + DeepSeek prefix-cache accounting.
 * Cache-hit input is billed far cheaper than cache-miss; we track both so the
 * footer can warn when the hit ratio drops (signal to /compact).
 */
import { pricingFor } from "./config.js";

export class CostTracker {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.state = {
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requests: 0,
      byModel: {},
    };
  }

  record(model, usage) {
    const price = pricingFor(this.config, model);
    const prompt = clampInt(usage.prompt_tokens);
    const completion = clampInt(usage.completion_tokens);
    let hit;
    let miss;
    const hasHit = usage.prompt_cache_hit_tokens != null;
    const hasMiss = usage.prompt_cache_miss_tokens != null;
    if (hasHit && hasMiss) {
      hit = clampInt(usage.prompt_cache_hit_tokens);
      miss = clampInt(usage.prompt_cache_miss_tokens);
    } else if (hasHit) {
      hit = clampInt(usage.prompt_cache_hit_tokens);
      miss = Math.max(0, prompt - hit);
    } else if (hasMiss) {
      miss = clampInt(usage.prompt_cache_miss_tokens);
      hit = Math.max(0, prompt - miss);
    } else {
      hit = 0;
      miss = prompt; // conservative: bill everything as cache-miss
    }
    const delta =
      (hit / 1e6) * price.cache_hit_usd + (miss / 1e6) * price.cache_miss_usd + (completion / 1e6) * price.output_usd;

    const s = this.state;
    s.promptTokens += prompt;
    s.completionTokens += completion;
    s.cacheHitTokens += hit;
    s.cacheMissTokens += miss;
    s.costUsd += delta;
    s.requests += 1;
    s.byModel[model] = s.byModel[model] || { requests: 0, costUsd: 0, tokens: 0 };
    s.byModel[model].requests += 1;
    s.byModel[model].costUsd += delta;
    s.byModel[model].tokens += prompt + completion;
    return delta;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  cacheHitRatio() {
    const total = this.state.cacheHitTokens + this.state.cacheMissTokens;
    return total === 0 ? null : this.state.cacheHitTokens / total;
  }

  footer() {
    const s = this.state;
    const ratio = this.cacheHitRatio();
    const cache = ratio == null ? "cache –" : `cache ${Math.round(ratio * 100)}%`;
    return `$${s.costUsd.toFixed(4)} · ${formatTokens(s.promptTokens + s.completionTokens)} tok · ${cache}`;
  }
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function clampInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
