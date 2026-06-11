/**
 * fake-deepseek.mjs — offline OpenAI/DeepSeek-compatible mock for e2e tests.
 * Scenario routing keys off the latest user message:
 *   PING        → streams text "pong from fake model"
 *   WRITE_TEST  → tool_calls write_file(tmp-e2e/hello.txt) then "file written ok"
 *   BASH_TEST   → tool_calls bash(echo e2e-bash-ok) then "bash done"
 *   SUMMARIZE   → (used by compaction) returns "SUMMARY: …"
 * Exports startFake() → {server, port, url}.
 */
import { createServer } from "node:http";

export function startFake() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }));
      return;
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const messages = parsed.messages || [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastMsg = messages[messages.length - 1];
      const text = typeof lastUser?.content === "string" ? lastUser.content : "";
      const sys = messages.find((m) => m.role === "system");
      const isSummarize = /Summarize this agent-session transcript/i.test(String(sys?.content || ""));

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish = null) => ({
        id: "fake",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

      const finishStream = (promptTok = 120) => {
        send({
          id: "fake",
          object: "chat.completion.chunk",
          choices: [],
          usage: {
            prompt_tokens: promptTok,
            completion_tokens: 30,
            prompt_cache_hit_tokens: Math.floor(promptTok / 2),
            prompt_cache_miss_tokens: Math.ceil(promptTok / 2),
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      };

      if (isSummarize) {
        send(chunk({ role: "assistant", content: "SUMMARY: goals, files, findings preserved." }));
        send(chunk({}, "stop"));
        finishStream(80);
        return;
      }

      // After a tool result, settle with text.
      if (lastMsg?.role === "tool") {
        const label = /hello\.txt/.test(JSON.stringify(messages)) ? "file written ok" : "bash done";
        send(chunk({ role: "assistant", content: label }));
        send(chunk({}, "stop"));
        finishStream();
        return;
      }

      if (/WRITE_TEST/.test(text)) {
        send(chunk({ role: "assistant", content: "" }));
        send(
          chunk({
            tool_calls: [
              { index: 0, id: "call_w1", type: "function", function: { name: "write_file", arguments: "" } },
            ],
          })
        );
        const args = JSON.stringify({ path: "tmp-e2e/hello.txt", content: "hello claudeseek" });
        for (const piece of [args.slice(0, 18), args.slice(18)]) {
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
        }
        send(chunk({}, "tool_calls"));
        finishStream();
        return;
      }

      if (/BASH_TEST/.test(text)) {
        send(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_b1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: `node -e "console.log('e2e-bash-ok')"` }) },
              },
            ],
          })
        );
        send(chunk({}, "tool_calls"));
        finishStream();
        return;
      }

      if (/REASONING_TEST/.test(text)) {
        send(chunk({ role: "assistant", reasoning_content: "thinking hard… " }));
        send(chunk({ content: "answer after thought" }));
        send(chunk({}, "stop"));
        finishStream();
        return;
      }

      // default: PING / echo
      const reply = /PING/.test(text) ? "pong from fake model" : `echo: ${text.slice(0, 60)}`;
      for (const piece of reply.match(/.{1,8}/g) || [reply]) {
        send(chunk({ content: piece }));
      }
      send(chunk({}, "stop"));
      finishStream();
    });
  });

  return new Promise((resolveP) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolveP({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// standalone: node scripts/fake-deepseek.mjs
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  startFake().then(({ url }) => console.log(`fake deepseek at ${url}`));
}
