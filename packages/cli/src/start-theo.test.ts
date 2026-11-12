/**
 * `mesh start` runs Theo alongside the proxy — exercised as a real subprocess
 * with an isolated HOME, a stub provider and a one-second Theo interval. The
 * proof that a cycle ran is Theo's memory file appearing beside the ledger,
 * which only `runTheoOnce` writes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

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

  function start(extra: string[]): { output: () => string } {
    let text = "";
    child = spawn(process.execPath, ["--import", "tsx", MAIN, "start", "--port", "0", "--no-install", ...extra], {
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
    expect(output()).toContain("I re-check every 1s (autonomy: recommend)");
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
    expect(output()).toContain("Not optimising this session (--no-theo)");
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
});
