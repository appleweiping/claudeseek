/**
 * theme.js — ANSI palette for the claudeseek CLI.
 *
 * Fusion identity: Claude's terracotta/cream warmth × DeepSeek's deep-sea blue.
 * Truecolor when supported, graceful 16-color fallback, NO_COLOR respected.
 */

const noColor =
  !!process.env.NO_COLOR ||
  process.env.TERM === "dumb" ||
  (!process.stdout.isTTY && !process.env.FORCE_COLOR);

const truecolor =
  !noColor &&
  (/truecolor|24bit/i.test(process.env.COLORTERM || "") ||
    !!process.env.WT_SESSION || // Windows Terminal
    !!process.env.FORCE_COLOR);

function rgb(r, g, b, fallback) {
  if (noColor) return ["", ""];
  if (truecolor) return [`\x1b[38;2;${r};${g};${b}m`, "\x1b[0m"];
  return [fallback, "\x1b[0m"];
}

function wrap([open, close]) {
  return (s) => `${open}${s}${close}`;
}

// Claude terracotta #D97757 · DeepSeek blue #4D6BFE · success green · soft gray
export const c = {
  orange: wrap(rgb(217, 119, 87, "\x1b[33m")), // Claude terracotta
  blue: wrap(rgb(77, 107, 254, "\x1b[34m")), // DeepSeek blue
  green: wrap(rgb(94, 182, 125, "\x1b[32m")),
  red: wrap(rgb(224, 90, 90, "\x1b[31m")),
  yellow: wrap(rgb(222, 184, 96, "\x1b[33m")),
  dim: wrap(noColor ? ["", ""] : ["\x1b[2m", "\x1b[0m"]),
  bold: wrap(noColor ? ["", ""] : ["\x1b[1m", "\x1b[0m"]),
  italic: wrap(noColor ? ["", ""] : ["\x1b[3m", "\x1b[0m"]),
  gray: wrap(rgb(148, 145, 138, "\x1b[90m")),
  cream: wrap(rgb(240, 238, 230, "\x1b[37m")),
};

/** The two-tone wordmark: "claude" in terracotta, "seek" in deep blue. */
export function wordmark() {
  return c.bold(c.orange("claude") + c.blue("seek"));
}

/** Status glyphs shared across the REPL. */
export const glyph = {
  dot: "⏺",
  corner: "⎿",
  arrow: "→",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
