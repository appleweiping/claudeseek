/**
 * undo.js — per-turn file snapshots (lightweight take on Claude Code's file
 * history). Before any write/edit the original is copied to
 * ~/.claudeseek/undo/<session>/<turn>/; /undo restores the latest turn.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { userDir } from "./config.js";

export class UndoManager {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.turn = 0;
    this.dirty = false;
  }

  baseDir() {
    return join(userDir(), "undo", this.sessionId);
  }

  beginTurn(turn) {
    this.turn = turn;
    this.dirty = false;
  }

  /** Snapshot a file before mutation. Missing file → recorded as "created". */
  snapshot(absPath) {
    try {
      const dir = join(this.baseDir(), String(this.turn));
      mkdirSync(dir, { recursive: true });
      const manifestPath = join(dir, "manifest.json");
      const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: [] };
      if (manifest.files.some((f) => f.path === absPath)) return; // first snapshot wins
      const entryName = `f${manifest.files.length}.bak`;
      if (existsSync(absPath)) {
        copyFileSync(absPath, join(dir, entryName));
        manifest.files.push({ path: absPath, backup: entryName, existed: true });
      } else {
        manifest.files.push({ path: absPath, existed: false });
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      this.dirty = true;
    } catch {
      /* undo is best-effort; never block the actual edit */
    }
  }

  /** Restore the most recent turn that has snapshots. @returns description */
  undoLast() {
    const base = this.baseDir();
    if (!existsSync(base)) return { ok: false, message: "Nothing to undo." };
    const turns = readdirSync(base)
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .sort((a, b) => b - a);
    for (const t of turns) {
      const dir = join(base, String(t));
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.files.length) continue;
      const restored = [];
      for (const f of manifest.files) {
        try {
          if (f.existed) {
            mkdirSync(dirname(f.path), { recursive: true });
            copyFileSync(join(dir, f.backup), f.path);
            restored.push(`restored ${f.path}`);
          } else if (existsSync(f.path)) {
            unlinkSync(f.path);
            restored.push(`removed ${f.path} (was created)`);
          }
        } catch (err) {
          restored.push(`FAILED ${f.path}: ${err.message}`);
        }
      }
      rmSync(dir, { recursive: true, force: true });
      return { ok: true, message: `Undid turn ${t}:\n` + restored.join("\n") };
    }
    return { ok: false, message: "Nothing to undo." };
  }
}
