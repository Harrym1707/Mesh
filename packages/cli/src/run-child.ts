/**
 * Run a child process in the foreground and stay with it until it exits.
 *
 * The launcher users download does nothing but start the runtime. It used to do
 * that with spawnSync, which blocks: a stop signal sent to the launcher killed
 * the launcher and left the runtime running with no parent, still listening on
 * its port (seen on 2026-11-25: `kill <launcher pid>` left the proxy up). A
 * supervisor, a script or an agent stops a program by signalling the process it
 * started, so the launcher has to pass that on.
 *
 * Which signals are passed on:
 *   - SIGTERM, always. Nothing but `kill` sends it, and it goes to one process.
 *   - SIGINT and SIGHUP, unless stdin is a terminal. Ctrl+C and a closed
 *     terminal window are delivered by the terminal to every process in the
 *     foreground group, the runtime included; passing them on as well would
 *     deliver them twice.
 * Either way the launcher no longer dies first: it waits, and ends the way the
 * child ended (same exit code, or the same signal).
 */
import { spawn } from "node:child_process";

export type ChildEnd = { code: number | null; signal: NodeJS.Signals | null };

export function runForeground(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdinIsTerminal: boolean = Boolean(process.stdin.isTTY),
): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    const pass = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* already gone */ } };
    const onTerm = (): void => pass("SIGTERM");
    const onInt = (): void => { if (!stdinIsTerminal) pass("SIGINT"); };
    const onHup = (): void => { if (!stdinIsTerminal) pass("SIGHUP"); };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    process.on("SIGHUP", onHup);
    const release = (): void => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      process.off("SIGHUP", onHup);
    };
    child.once("error", (error) => { release(); reject(error); });
    child.once("exit", (code, signal) => { release(); resolve({ code, signal }); });
  });
}

/** End this process the way the child ended. */
export function exitLike(end: ChildEnd): never {
  if (end.signal) {
    // Die by the same signal so a caller reading our status sees what happened.
    process.kill(process.pid, end.signal);
    // Not every signal ends a process; if this one did not, report failure.
    return process.exit(1);
  }
  return process.exit(end.code ?? 0);
}
