/**
 * The terminal helper, and the rule it exists to keep: no command writes an
 * ANSI escape sequence except through `style()`, which stays silent whenever
 * stdout is not a terminal, NO_COLOR is set or TERM is dumb.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { colourEnabled, hasEscapeCodes, isInteractive, style } from "./terminal.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("colourEnabled", () => {
  it("is on only for a terminal with nothing asking for plain output", () => {
    expect(colourEnabled(tty, {})).toBe(true);
    expect(colourEnabled(tty, { TERM: "xterm-256color" })).toBe(true);
  });
  it("is off when stdout is a pipe, a file or an agent's capture", () => {
    expect(colourEnabled(pipe, {})).toBe(false);
    expect(colourEnabled({}, {})).toBe(false);
  });
  it("is off under NO_COLOR and TERM=dumb, even on a terminal", () => {
    expect(colourEnabled(tty, { NO_COLOR: "1" })).toBe(false);
    expect(colourEnabled(tty, { TERM: "dumb" })).toBe(false);
    // An empty NO_COLOR is not a request (https://no-color.org).
    expect(colourEnabled(tty, { NO_COLOR: "" })).toBe(true);
  });
});

describe("style", () => {
  it("wraps text in SGR codes on a colour terminal", () => {
    const styled = style("ok", ["bold", "green"], tty, {});
    expect(styled).toBe("\u001b[1;32mok\u001b[0m");
    expect(hasEscapeCodes(styled)).toBe(true);
  });
  it("returns the text unchanged everywhere else", () => {
    expect(style("ok", ["bold"], pipe, {})).toBe("ok");
    expect(style("ok", ["bold"], tty, { NO_COLOR: "1" })).toBe("ok");
    expect(style("ok", ["bold"], tty, { TERM: "dumb" })).toBe("ok");
    expect(style("ok", [], tty, {})).toBe("ok");
  });
});

describe("isInteractive", () => {
  it("needs a terminal on both stdin and stdout", () => {
    expect(isInteractive({}, { stdin: tty, stdout: tty })).toBe(true);
    expect(isInteractive({}, { stdin: pipe, stdout: tty })).toBe(false);
    expect(isInteractive({}, { stdin: tty, stdout: pipe })).toBe(false);
  });
  it("is never true under CI", () => {
    expect(isInteractive({ CI: "1" }, { stdin: tty, stdout: tty })).toBe(false);
    expect(isInteractive({ CI: "true" }, { stdin: tty, stdout: tty })).toBe(false);
  });
});

describe("the CLI sources", () => {
  it("write no escape sequence outside terminal.ts", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    // An ESC byte, or one spelled as a string escape (\x1b, \u001b, \033, \e[).
    const escape = /[\u001b\u009b]|\\x1b|\\u001b|\\u\{1b\}|\\033|\\e\[/i;
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "terminal.ts")
      .filter((file) => escape.test(readFileSync(join(dir, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
