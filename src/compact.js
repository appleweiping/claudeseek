/**
 * compact.js — context compaction. CJK-aware token estimate; when the
 * conversation nears the model window, older turns are summarized by V4 Flash
 * and replaced with a compact boundary message (tool-call-pair safe).
 */

/** Rough token estimate: CJK ≈ 1 tok/char, ASCII ≈ 1 tok/3.6 chars. */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else if (code >= 0xac00 && code <= 0xd7af) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3.6);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += 6;
    if (typeof m.content === "string") total += estimateTokens(m.content);
    if (m.reasoning_content) total += estimateTokens(m.reasoning_content);
    for (const tc of m.tool_calls || []) {
      total += estimateTokens(tc.function?.name) + estimateTokens(tc.function?.arguments);
    }
  }
  return total;
}

/**
 * Compact messages in place when needed.
 * Keeps: all system messages + the most recent `keepTurns` user→… spans,
 * never splitting an assistant tool_calls / tool result pair.
 */
export async function compactMessages({ client, messages, contextWindow, threshold = 0.75, force = false, keepRecent = 8 }) {
  const est = estimateMessagesTokens(messages);
  const limit = Math.floor(contextWindow * threshold);
  if (!force && est < limit) return { compacted: false, est, limit };

  // Find the cut point: keep the last `keepRecent` messages, then walk back
  // to a boundary where we don't orphan tool results.
  let cut = Math.max(0, messages.length - keepRecent);
  while (cut > 0 && messages[cut]?.role === "tool") cut--;
  if (cut <= 1) return { compacted: false, est, limit };

  const head = messages.slice(0, cut).filter((m) => m.role !== "system");
  if (!head.length) return { compacted: false, est, limit };

  const transcript = head
    .map((m) => {
      if (m.role === "tool") return `[tool ${m.tool_call_id}] ${trim(m.content, 400)}`;
      if (m.role === "assistant" && m.tool_calls?.length) {
        return `assistant called: ${m.tool_calls.map((t) => `${t.function.name}(${trim(t.function.arguments, 160)})`).join(", ")}${m.content ? ` — ${trim(m.content, 400)}` : ""}`;
      }
      return `${m.role}: ${trim(m.content, 800)}`;
    })
    .join("\n");

  let summary;
  try {
    const res = await client.complete({
      model: "deepseek-v4-flash",
      thinking: "disabled",
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "Summarize this agent-session transcript for context continuation. Preserve: user goals, decisions made, files created/modified (exact paths), key findings, current state, and what remains to do. Dense bullet points, no preamble.",
        },
        { role: "user", content: transcript.slice(0, 60000) },
      ],
    });
    summary = res.content || "(summary unavailable)";
  } catch (err) {
    // Offline fallback: keep a mechanical digest so compaction still works.
    summary = mechanicalDigest(head);
  }

  const systems = messages.filter((m) => m.role === "system");
  const tail = messages.slice(cut);
  const boundary = {
    role: "user",
    content: `[context compacted — summary of ${head.length} earlier messages]\n${summary}`,
    _meta: { compactBoundary: true },
  };
  messages.length = 0;
  messages.push(...systems, boundary, ...tail);
  return { compacted: true, est, limit, summaryChars: summary.length };
}

function mechanicalDigest(head) {
  const files = new Set();
  const cmds = [];
  let firstUser = "";
  for (const m of head) {
    if (!firstUser && m.role === "user" && typeof m.content === "string") firstUser = trim(m.content, 300);
    for (const tc of m.tool_calls || []) {
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (args.path) files.add(args.path);
        if (args.command) cmds.push(trim(args.command, 80));
      } catch {
        /* unparseable args don't matter for the digest */
      }
    }
  }
  return [
    `initial request: ${firstUser}`,
    files.size ? `files touched: ${[...files].slice(0, 30).join(", ")}` : "",
    cmds.length ? `commands run: ${cmds.slice(0, 15).join(" | ")}` : "",
    "(offline digest — model summary unavailable)",
  ]
    .filter(Boolean)
    .join("\n");
}

function trim(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
