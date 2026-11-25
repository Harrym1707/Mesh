import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The launcher must not leave the runtime behind. Each test starts a stand-in
 * launcher (runForeground + exitLike, exactly what bootstrap.ts does) around a
 * stand-in runtime that prints its pid and shuts down on a stop signal, then
 * signals the LAUNCHER only and checks what became of the runtime.
 */
const RUN_CHILD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "run-child.ts")).href;

let dir: string;
let launcher: ChildProcess | undefined;
let runtimePid: number | undefined;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

/** Start launcher → runtime; resolves once the runtime has printed its pid. */
async function start(runtimeBody: string, stdinIsTerminal: boolean): Promise<{ output: () => string; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> {
  const runtime = path.join(dir, "runtime.mjs");
  writeFileSync(runtime, runtimeBody);
  const launcherFile = path.join(dir, "launcher.mts");
  writeFileSync(launcherFile, [
    `import { exitLike, runForeground } from ${JSON.stringify(RUN_CHILD)};`,
    `const end = await runForeground(process.execPath, [${JSON.stringify(runtime)}], process.env, ${stdinIsTerminal});`,
    `exitLike(end);`,
  ].join("\n"));
  let out = "";
  launcher = spawn(process.execPath, ["--import", "tsx", launcherFile], { stdio: ["ignore", "pipe", "pipe"] });
  launcher.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  launcher.stderr!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    launcher!.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = await until(() => /pid=(\d+)/.test(out), 15000);
  if (!ready) throw new Error(`runtime never reported its pid. Output:\n${out}`);
  runtimePid = Number(/pid=(\d+)/.exec(out)![1]);
  return { output: () => out, ended };
}

const GRACEFUL = `
console.log("pid=" + process.pid);
const stop = (name) => () => { console.log("runtime got " + name); setTimeout(() => process.exit(0), 50); };
process.on("SIGTERM", stop("SIGTERM"));
process.on("SIGINT", stop("SIGINT"));
process.on("SIGHUP", stop("SIGHUP"));
setInterval(() => {}, 1000);
`;

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "mesh-run-child-")); });
afterEach(() => {
  if (runtimePid && alive(runtimePid)) process.kill(runtimePid, "SIGKILL");
  if (launcher?.pid && alive(launcher.pid)) launcher.kill("SIGKILL");
  launcher = undefined; runtimePid = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("the launcher stays with the runtime and passes stop signals on", () => {
  it("SIGTERM to the launcher stops the runtime, and the launcher waits for it", async () => {
    const run = await start(GRACEFUL, true);
    launcher!.kill("SIGTERM");
    const end = await run.ended;
    expect(run.output()).toContain("runtime got SIGTERM");
    expect(alive(runtimePid!)).toBe(false);
    // The runtime shut down cleanly, so the launcher reports a clean exit.
    expect(end).toEqual({ code: 0, signal: null });
  }, 30000);

  it("passes SIGINT and SIGHUP on when there is no terminal to deliver them", async () => {
    for (const signal of ["SIGINT", "SIGHUP"] as const) {
      const run = await start(GRACEFUL, false);
      launcher!.kill(signal);
      await run.ended;
      expect(run.output(), signal).toContain(`runtime got ${signal}`);
      expect(alive(runtimePid!), signal).toBe(false);
    }
  }, 60000);

  it("does not deliver SIGINT a second time when a terminal already delivers it to the group", async () => {
    const run = await start(GRACEFUL, true);
    launcher!.kill("SIGINT");
    // Nothing is forwarded; the launcher keeps waiting and the runtime is untouched.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(run.output()).not.toContain("runtime got");
    expect(alive(runtimePid!)).toBe(true);
    expect(alive(launcher!.pid!)).toBe(true);
    // The terminal's own delivery reaches the runtime; the launcher then ends with it.
    process.kill(runtimePid!, "SIGINT");
    expect(await run.ended).toEqual({ code: 0, signal: null });
  }, 30000);

  it("ends with the runtime's exit code", async () => {
    const run = await start(`console.log("pid=" + process.pid); setTimeout(() => process.exit(7), 100);`, true);
    expect(await run.ended).toEqual({ code: 7, signal: null });
  }, 30000);

  it("ends by the same signal when the runtime is killed outright", async () => {
    const run = await start(`console.log("pid=" + process.pid); setInterval(() => {}, 1000);`, true);
    process.kill(runtimePid!, "SIGKILL");
    expect(await run.ended).toEqual({ code: null, signal: "SIGKILL" });
  }, 30000);
});
