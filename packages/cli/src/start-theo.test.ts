/**
 * `mesh start` runs Theo alongside the proxy — exercised as a real subprocess
 * with an isolated HOME, a stub provider and a one-second Theo interval. The
 * proof that a cycle ran is Theo's memory file appearing beside the ledger,
 * which only `runTheoOnce` writes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMeshProxy } from "../../sdk-js/src/proxy.js";
import { onlyOnce, portInUseMessage } from "./start.js";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
// What a downloaded user actually runs: the runtime has its own command table.
const RUNTIME = fileURLToPath(new URL("./mesh-runtime.ts", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/** A provider stand-in: answers every request with a small, valid usage block. */
function stubProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_stub",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 120, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    });
  });
}

describe("mesh start — Theo runs alongside the proxy", () => {
  let home: string;
  let child: ChildProcess | undefined;
  let provider: { server: Server; url: string } | undefined;

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mesh-start-theo-")); });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve())).catch(() => undefined);
    }
    child = undefined;
    provider?.server.close();
    provider = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function start(extra: string[], command: string[] = ["start", "--no-install"], entry = MAIN): { output: () => string } {
    let text = "";
    const port = command.includes("--port") ? [] : ["--port", "0"];
    child = spawn(process.execPath, ["--import", "tsx", entry, ...command, ...port, ...extra], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    return { output: () => text };
  }

  it("runs a Theo cycle over the traffic it proxies, and says so in the banner", { timeout: 40_000 }, async () => {
    provider = await stubProvider();
    const { output } = start(["--anthropic-base", provider.url, "--theo-interval", "1s"]);

    expect(await waitFor(() => /proxy\s+http:\/\/127\.0\.0\.1:\d+/.test(output()))).toBe(true);
    // The banner arrives in more than one chunk: wait for the later line rather
    // than assert it the moment the proxy line shows (that raced on a CI runner
    // and failed the v0.2.0 release run).
    expect(await waitFor(() => output().includes("I re-check every 1s (autonomy: recommend)"))).toBe(true);
    const proxyUrl = /proxy\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output())![1]!;

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 50,
        system: "You are terse.",
        messages: [{ role: "user", content: "Say ok." }],
      }),
    });
    await response.arrayBuffer();
    expect(response.status).toBe(200);

    // Only a Theo cycle writes this file; before the fix `mesh start` never did.
    const memoryPath = join(home, ".mesh", "ledger", "theo", "local.json");
    expect(await waitFor(() => existsSync(memoryPath))).toBe(true);
    const memory = JSON.parse(readFileSync(memoryPath, "utf8")) as { autonomy: string; log: unknown[] };
    expect(memory.autonomy).toBe("recommend");
    expect(memory.log.length).toBeGreaterThan(0);
    // Quiet beside the proxy: the full report stays in `mesh theo`.
    expect(output()).not.toContain("OBSERVE:");
  });

  it("--no-theo runs the proxy only, and says so", { timeout: 40_000 }, async () => {
    provider = await stubProvider();
    const { output } = start(["--anthropic-base", provider.url, "--theo-interval", "1s", "--no-theo"]);

    expect(await waitFor(() => /proxy\s+http:\/\/127\.0\.0\.1:\d+/.test(output()))).toBe(true);
    expect(await waitFor(() => output().includes("Not optimising this session (--no-theo)"))).toBe(true);
    const proxyUrl = /proxy\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output())![1]!;
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 50, messages: [{ role: "user", content: "Say ok." }] }),
    });
    await response.arrayBuffer();

    await sleep(2500); // more than two intervals
    expect(existsSync(join(home, ".mesh", "ledger", "theo", "local.json"))).toBe(false);
  });

  it("the shipped runtime knows every client command the developer entry lists", () => {
    const commands = (file: string): string[] =>
      [...readFileSync(file, "utf8").matchAll(/^ {2}([a-z]+) {2,}\S/gm)].map((match) => match[1]!);
    const shipped = new Set(commands(RUNTIME));
    // `analyse` is a developer tool and deliberately not in the download.
    const missing = commands(MAIN).filter((name) => name !== "analyse" && !shipped.has(name));
    expect(missing).toEqual([]);
    expect(shipped.has("proxy")).toBe(true);
  });

  it("a taken port gets a sentence a person can act on, not a system error", { timeout: 40_000 }, async () => {
    // Taken by another program.
    provider = await stubProvider();
    const takenPort = new URL(provider.url).port;
    const other = start(["--no-theo"], ["proxy", "--port", takenPort]);
    expect(await waitFor(() => child!.exitCode !== null)).toBe(true);
    expect(child!.exitCode).toBe(1);
    expect(other.output()).toContain(`Port ${takenPort} is in use by another program`);
    expect(other.output()).not.toContain("EADDRINUSE");

    // Taken by MESH itself.
    const first = start(["--anthropic-base", provider.url, "--no-theo"], ["proxy"]);
    expect(await waitFor(() => /proxy\s+http:\/\/127\.0\.0\.1:\d+/.test(first.output()))).toBe(true);
    const meshPort = /proxy\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(first.output())![1]!;
    const firstChild = child!;
    const second = start(["--no-theo"], ["proxy", "--port", meshPort]);
    expect(await waitFor(() => child!.exitCode !== null)).toBe(true);
    expect(second.output()).toContain(`A MESH proxy is already answering on port ${meshPort} (see: mesh status).`);
    // Nothing in this home points Claude Code at it, and the message does not pretend otherwise.
    expect(second.output()).toContain("Claude Code's settings do not point at it");
    expect(second.output()).not.toContain("Claude Code is already using it");
    child = firstChild; // afterEach stops the one still running
  });

  it("recognises an older MESH on the port, and never suggests a port that does not exist", async () => {
    // A build from before the health check answers it with its own 404.
    const older = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "MESH proxy forwards POST /v1/messages (Anthropic), /v1/responses and /v1/chat/completions (OpenAI-compatible)." }));
    });
    await new Promise<void>((resolve) => older.listen(0, "127.0.0.1", () => resolve()));
    const port = (older.address() as { port: number }).port;
    try {
      expect(await portInUseMessage(port, { settingsPath: join(home, "settings.json"), statePath: join(home, "wiring.json") }))
        .toContain(`A MESH proxy is already answering on port ${port}`);
    } finally {
      older.close();
    }
    expect(await portInUseMessage(65535, { settingsPath: join(home, "settings.json"), statePath: join(home, "wiring.json") })).toContain("--port 65534");
  });

  it("a taken port: says Claude Code is using that proxy only when its settings point there", async () => {
    const paths = { settingsPath: join(home, "settings.json"), statePath: join(home, "wiring.json") };
    const mesh = createServer((req, res) => {
      res.writeHead(req.url === "/mesh/health" ? 200 : 404, { "content-type": "application/json" });
      res.end('{"status":"ok","service":"mesh-proxy"}');
    });
    await new Promise<void>((resolve) => mesh.listen(0, "127.0.0.1", () => resolve()));
    const port = (mesh.address() as { port: number }).port;
    try {
      // A stale copy holds the port and Claude Code is connected to nothing: no settings file at all.
      const stale = await portInUseMessage(port, paths);
      expect(stale).toBe(
        `A MESH proxy is already answering on port ${port} (see: mesh status). ` +
        "Claude Code's settings do not point at it, so Claude Code is not using it. " +
        `An app can use it at http://127.0.0.1:${port}. To run this copy too, stop the other one first, or add --port ${port + 1}.`,
      );
      expect(stale).not.toContain("always-on service");
      expect(stale).not.toContain("already using it");
      // Pointed somewhere else, with a credential in the address: still "do not point", and nothing of it is repeated.
      writeFileSync(paths.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://user:sk-PLANTED@gateway.example/v1" } }));
      const elsewhere = await portInUseMessage(port, paths);
      expect(elsewhere).toContain("Claude Code's settings do not point at it");
      expect(elsewhere).not.toContain("PLANTED");
      expect(elsewhere).not.toContain("gateway.example");
      // Pointed at this proxy: now it is said, because it is known.
      writeFileSync(paths.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }));
      expect(await portInUseMessage(port, paths)).toContain("Claude Code's settings point at it.");
      // A settings file that cannot be read: not known, and said so.
      writeFileSync(paths.settingsPath, "{ not json");
      expect(await portInUseMessage(port, paths)).toContain("Whether Claude Code is using it is not known: its settings file cannot be read as JSON.");
    } finally {
      mesh.close();
    }
  });

  it("closing the proxy twice rejects, and the shutdown guard makes a second stop do nothing", async () => {
    // The fact the guard exists for: the real proxy's close is not safe to call twice.
    const proxy = await startMeshProxy({ ledgerDirectory: join(home, "ledger") });
    await proxy.close();
    await expect(proxy.close()).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });

    // A close that behaves the same way, behind the guard `mesh serve` uses.
    let closes = 0;
    const close = (): Promise<void> => { closes += 1; return closes === 1 ? Promise.resolve() : Promise.reject(new Error("closed twice")); };
    const shutdown = onlyOnce(async () => { await close(); });
    await expect(Promise.all([shutdown(), shutdown(), shutdown()])).resolves.toEqual([undefined, undefined, undefined]);
    await expect(shutdown()).resolves.toBeUndefined();
    expect(closes).toBe(1);
    // Without the guard the second stop rejects: this is what a second signal used to do.
    await close().then(() => { throw new Error("expected a rejection"); }, (error: Error) => expect(error.message).toBe("closed twice"));
  });

  it("mesh serve stops cleanly when it is told to stop twice", { timeout: 40_000 }, async () => {
    // launchd, a supervisor or an impatient Ctrl+C can deliver a second signal
    // while the first is still closing the proxy. A request in flight keeps
    // the proxy closing for as long as this test wants, so the second signal
    // lands inside that window every time.
    let release: () => void = () => {};
    const slow = createServer((req, res) => {
      req.resume();
      release = () => {
        if (res.headersSent) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_stub", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }));
      };
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", () => resolve()));
    try {
      const upstream = `http://127.0.0.1:${(slow.address() as { port: number }).port}`;
      const { output } = start(["--no-theo", "--anthropic-base", upstream], ["serve"], RUNTIME);
      expect(await waitFor(() => /mesh serve · build .* proxy http:\/\/127\.0\.0\.1:\d+/.test(output()))).toBe(true);
      const proxyUrl = /proxy (http:\/\/127\.0\.0\.1:\d+)/.exec(output())![1]!;
      const serving = child!;
      const inFlight = fetch(`${proxyUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "caller-key" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 50, messages: [{ role: "user", content: "Say ok." }] }),
      }).then((response) => response.arrayBuffer()).catch(() => undefined);
      await sleep(400); // the request has reached the provider stand-in and is waiting there

      serving.kill("SIGTERM");
      await sleep(200);
      serving.kill("SIGTERM");
      serving.kill("SIGINT");
      await sleep(600);
      // Still closing, waiting for the request in flight: the extra signals did nothing.
      expect(serving.exitCode).toBeNull();
      expect(serving.signalCode).toBeNull();
      expect(output()).not.toContain("ERR_SERVER_NOT_RUNNING");

      release();
      await inFlight;
      expect(await waitFor(() => serving.exitCode !== null || serving.signalCode !== null)).toBe(true);
      expect(serving.signalCode).toBeNull();
      expect(serving.exitCode).toBe(0);
      expect(output()).not.toContain("ERR_SERVER_NOT_RUNNING");
      // It changed nothing in Claude Code's settings on the way in or out.
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    } finally {
      release();
      slow.closeAllConnections();
      slow.close();
    }
  });

  it("mesh proxy serves any app, says how to connect, and leaves Claude Code's settings alone", { timeout: 40_000 }, async () => {
    provider = await stubProvider();
    const settingsPath = join(home, ".claude", "settings.json");
    const settings = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.invalid" }, theme: "dark" }, null, 2)}\n`;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, settings);

    // Through the shipped runtime entry, not the developer one.
    const { output } = start(["--anthropic-base", provider.url, "--no-theo"], ["proxy"], RUNTIME);
    expect(await waitFor(() => /proxy\s+http:\/\/127\.0\.0\.1:\d+/.test(output()))).toBe(true);
    const proxyUrl = /proxy\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output())![1]!;
    expect(await waitFor(() => output().includes("Run your app as normal."))).toBe(true);
    expect(output()).toContain(`ANTHROPIC_BASE_URL=${proxyUrl}`);
    expect(output()).toContain(`OPENAI_BASE_URL=${proxyUrl}/v1`);
    expect(output()).not.toContain("Just use Claude Code");

    const health = await fetch(`${proxyUrl}/mesh/health`);
    expect(await health.json()).toEqual({ status: "ok", service: "mesh-proxy" });

    // A call MESH does not reduce still reaches the provider.
    const counted = await fetch(`${proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }] }),
    });
    expect(counted.status).toBe(200);

    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
  });
});
