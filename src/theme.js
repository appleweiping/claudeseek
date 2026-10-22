/**
 * theme.js — ANSI palette for the claudeseek CLI.
 *
 * Truecolor when supported, 16-color fallback, NO_COLOR respected.
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

export const c = {
  orange: wrap(rgb(230, 150, 70, "\x1b[33m")), // accent: prompt, spinner
  blue: wrap(rgb(77, 107, 254, "\x1b[34m")), // tool calls, wordmark
  green: wrap(rgb(94, 182, 125, "\x1b[32m")),
  red: wrap(rgb(224, 90, 90, "\x1b[31m")),
  yellow: wrap(rgb(222, 184, 96, "\x1b[33m")),
  dim: wrap(noColor ? ["", ""] : ["\x1b[2m", "\x1b[0m"]),
  bold: wrap(noColor ? ["", ""] : ["\x1b[1m", "\x1b[0m"]),
  italic: wrap(noColor ? ["", ""] : ["\x1b[3m", "\x1b[0m"]),
  gray: wrap(rgb(148, 145, 138, "\x1b[90m")),
  cream: wrap(rgb(240, 238, 230, "\x1b[37m")),
};

/** The program name as printed in banners. */
export function wordmark() {
  return c.bold(c.blue("claudeseek"));
}

/** Status glyphs shared across the REPL. */
export const glyph = {
  dot: "⏺",
  corner: "⎿",
  arrow: "→",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
