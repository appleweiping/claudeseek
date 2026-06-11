/**
 * router.js — zero-cost per-turn model router (keyword heuristic, no LLM call).
 * Hard signals (debug/architecture/调试/根因…) → V4 Pro + max thinking;
 * light signals (search/format/翻译…) → Flash non-thinking; default → Flash+think.
 */

const HIGH = [
  "debug", "error", "crash", "panic", "stack trace", "traceback", "race condition",
  "deadlock", "architecture", "refactor", "design", "why does", "root cause",
  "security", "vulnerability", "optimize", "performance", "concurrency", "prove",
  "调试", "错误", "报错", "出错", "崩溃", "架构", "重构", "设计", "为什么", "根因",
  "性能", "优化", "安全", "漏洞", "并发", "死锁", "デバッグ", "エラー", "設計",
];

const LOW = [
  "search", "lookup", "look up", "find", "list", "format", "rename", "typo",
  "what is", "show me", "print", "echo", "summarize", "translate",
  "搜索", "查找", "查询", "列出", "格式化", "重命名", "翻译", "总结", "显示",
  "検索", "一覧", "翻訳",
];

export function route({ lastUserMessage, isSubagent = false }) {
  if (isSubagent) {
    return { model: "deepseek-v4-flash", thinking: "disabled", reasoning_effort: "high", reason: "sub-agent → flash" };
  }
  const text = String(lastUserMessage || "").toLowerCase();
  const high = match(text, HIGH);
  if (high) return { model: "deepseek-v4-pro", thinking: "enabled", reasoning_effort: "max", reason: `hard signal "${high}"` };
  const low = match(text, LOW);
  if (low) return { model: "deepseek-v4-flash", thinking: "disabled", reasoning_effort: "high", reason: `light signal "${low}"` };
  return { model: "deepseek-v4-flash", thinking: "enabled", reasoning_effort: "high", reason: "default" };
}

function match(text, keywords) {
  for (const k of keywords) {
    if (/^[\x00-\x7f]+$/.test(k)) {
      const re = new RegExp(`(?:^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z]*(?:$|[^a-z0-9])`, "i");
      if (re.test(text)) return k;
    } else if (text.includes(k)) return k;
  }
  return undefined;
}
