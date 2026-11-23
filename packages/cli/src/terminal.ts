/**
 * The one place the CLI decides how to behave on a terminal versus under an
 * unattended caller (a coding agent, CI, a pipe, a service manager).
 *
 * Rules every command follows:
 *   - No ANSI colour or cursor codes unless `colourEnabled()` says so. Styled
 *     text goes through `style()`; nothing else in packages/cli/src may write
 *     an escape sequence (terminal.test.ts scans the sources for one).
 *   - Nothing reads stdin. A command that would need an answer takes it as a
 *     flag and fails with a plain message naming the flag.
 *   - Nothing opens a browser, a pager or an editor unless `isInteractive()`.
 */

type Env = Record<string, string | undefined>;
type StreamLike = { isTTY?: boolean };

const set = (value: string | undefined): boolean => value !== undefined && value !== "";

/**
 * May this stream be sent ANSI codes? Never when it is not a terminal (a pipe,
 * a file, an agent's capture), when NO_COLOR is set (https://no-color.org),
 * or when the terminal says it cannot render them (TERM=dumb).
 */
export function colourEnabled(stream: StreamLike = process.stdout, env: Env = process.env): boolean {
  if (stream.isTTY !== true) return false;
  if (set(env.NO_COLOR)) return false;
  if (env.TERM === "dumb") return false;
  return true;
}

/** SGR codes this CLI may use. Add here, never inline at a call site. */
export const SGR = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34 } as const;

/** `text` wrapped in the given SGR codes, or `text` unchanged when colour is off. */
export function style(
  text: string,
  codes: readonly (keyof typeof SGR)[],
  stream: StreamLike = process.stdout,
  env: Env = process.env,
): string {
  if (codes.length === 0 || !colourEnabled(stream, env)) return text;
  return `\u001b[${codes.map((code) => SGR[code]).join(";")}m${text}\u001b[0m`;
}

/**
 * Is a person at the keyboard? True only when stdin AND stdout are terminals
 * and CI is not set. Decides whether a command may do something only a person
 * wants (open a browser). An agent, a pipe, a hook or a service is never
 * interactive.
 */
export function isInteractive(
  env: Env = process.env,
  streams: { stdin: StreamLike; stdout: StreamLike } = { stdin: process.stdin, stdout: process.stdout },
): boolean {
  if (set(env.CI)) return false;
  return streams.stdin.isTTY === true && streams.stdout.isTTY === true;
}

/** True when `text` holds an ESC byte or a C1 control sequence introducer. */
export function hasEscapeCodes(text: string): boolean {
  return /[\u001b\u009b]/.test(text);
}
