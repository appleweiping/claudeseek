/**
 * web.js — fetch_url tool. GET a URL, return readable text (HTML stripped),
 * size-capped. http(s) only; redirects followed up to 5; 20s timeout.
 */

const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_CHARS = 40000;

export const fetchUrlTool = {
  name: "fetch_url",
  kind: "net",
  description: "Fetch a URL over HTTP(S) and return its text content (HTML is reduced to readable text).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL" },
      raw: { type: "boolean", description: "Return raw body without HTML stripping (default false)" },
    },
    required: ["url"],
  },
  async execute(input, ctx) {
    let url;
    try {
      url = new URL(String(input.url));
    } catch {
      return { ok: false, output: `Invalid URL: ${input.url}` };
    }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, output: "Only http/https URLs are allowed." };
    try {
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
      const res = await fetch(url, {
        redirect: "follow",
        signal,
        headers: { "User-Agent": "claudeseek/1.0 (+https://github.com/appleweiping/claudeseek)" },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const body = buf.subarray(0, MAX_BYTES).toString("utf8");
      const contentType = res.headers.get("content-type") || "";
      let text = body;
      if (!input.raw && /html/i.test(contentType)) text = htmlToText(body);
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + `\n… (truncated, ${text.length} chars)`;
      return { ok: res.ok, output: `HTTP ${res.status} ${contentType}\n\n${text}` };
    } catch (err) {
      return { ok: false, output: `fetch failed: ${err?.message || err}` };
    }
  },
};

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
