/**
 * skills.js — SKILL.md discovery (cross-tool compatible).
 * Looks in workspace .claudeseek/skills, .claude/skills, .agents/skills and
 * the user-global ~/.claudeseek/skills. Frontmatter: name + description.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function discoverSkills(cwd) {
  const roots = [
    join(cwd, ".claudeseek", "skills"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".claudeseek", "skills"),
  ];
  const skills = [];
  const seen = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillPath = join(root, e.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      try {
        const meta = parseFrontmatter(readFileSync(skillPath, "utf8"));
        const name = meta.name || e.name;
        if (seen.has(name)) continue;
        seen.add(name);
        skills.push({ name, description: meta.description || "(no description)", path: skillPath });
      } catch {
        /* malformed skills are skipped, not fatal */
      }
      if (skills.length >= 50) return skills;
    }
  }
  return skills;
}

export function loadSkill(cwd, name) {
  const skill = discoverSkills(cwd).find((s) => s.name === name);
  if (!skill) return null;
  try {
    return { ...skill, content: readFileSync(skill.path, "utf8").slice(0, 30000) };
  } catch {
    return null;
  }
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.+)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
