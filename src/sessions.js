/**
 * sessions.js — durable session store under ~/.claudeseek/sessions/.
 * One JSON file per session; tolerant loader; resume by id prefix or --last.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { userDir } from "./config.js";

const DIR = () => join(userDir(), "sessions");

export function newSessionId() {
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${ts}-${randomBytes(3).toString("hex")}`;
}

export function createSession({ cwd, model }) {
  return {
    v: 1,
    id: newSessionId(),
    title: "",
    cwd,
    model,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    messages: [],
    todos: [],
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
  };
}

export function saveSession(session) {
  mkdirSync(DIR(), { recursive: true });
  session.updated = new Date().toISOString();
  const path = join(DIR(), `${session.id}.json`);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(session), "utf8");
  renameSync(tmp, path); // atomic-ish on same volume
  return path;
}

export function loadSession(idOrPrefix) {
  const id = matchSessionId(idOrPrefix);
  if (!id) return null;
  try {
    const s = JSON.parse(readFileSync(join(DIR(), `${id}.json`), "utf8"));
    return s?.v === 1 ? s : null;
  } catch {
    return null;
  }
}

export function matchSessionId(idOrPrefix) {
  if (!idOrPrefix) return null;
  const all = listSessionIds();
  if (all.includes(idOrPrefix)) return idOrPrefix;
  const hits = all.filter((s) => s.startsWith(idOrPrefix));
  return hits.length === 1 ? hits[0] : null;
}

export function listSessionIds() {
  if (!existsSync(DIR())) return [];
  return readdirSync(DIR())
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map((f) => f.slice(0, -5))
    .sort()
    .reverse();
}

export function listSessions(limit = 25) {
  const out = [];
  for (const id of listSessionIds().slice(0, limit)) {
    try {
      const s = JSON.parse(readFileSync(join(DIR(), `${id}.json`), "utf8"));
      out.push({
        id,
        title: s.title || firstUserLine(s) || "(untitled)",
        updated: s.updated,
        cwd: s.cwd,
        messages: s.messages?.length || 0,
        costUsd: s.usage?.costUsd || 0,
      });
    } catch {
      /* skip corrupt session files */
    }
  }
  return out;
}

export function lastSessionId() {
  const ids = listSessionIds();
  if (!ids.length) return null;
  // listSessionIds sorts lexicographically desc; ids start with a timestamp so
  // that already is most-recent-first, but prefer updated time when present.
  let best = null;
  let bestTime = "";
  for (const id of ids.slice(0, 50)) {
    try {
      const s = JSON.parse(readFileSync(join(DIR(), `${id}.json`), "utf8"));
      if ((s.updated || "") > bestTime) {
        bestTime = s.updated || "";
        best = id;
      }
    } catch {
      /* skip */
    }
  }
  return best || ids[0];
}

function firstUserLine(session) {
  const m = (session.messages || []).find((m) => m.role === "user" && typeof m.content === "string");
  return m ? m.content.split("\n")[0].slice(0, 80) : "";
}
