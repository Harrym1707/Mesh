import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMeshProxy, type MeshProxy } from "./proxy.js";
import type { MeshTokenReductionConfig } from "./reduce-request.js";

type AnyObject = Record<string, any>;

/** Minimal Anthropic stub that records the bodies it was forwarded. */
function stubUpstream(seen: AnyObject[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnyObject;
      seen.push(body);
      const inputTokens = Math.ceil(JSON.stringify(body).length / 4);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_stub",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(20);
}

function toolHeavyRequest(): unknown {
  return {
    model: "claude-sonnet-5-5-20260514",
    max_tokens: 100,
    system: "You are terse.",
    tools: [{ name: "search", description: "Search the corpus and return the most relevant passages for the query. ".repeat(20), input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    messages: [{ role: "user", content: "Find the reconciliation clause." }],
  };
}

async function post(proxy: MeshProxy, app: string): Promise<void> {
  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-mesh-application": app },
    body: JSON.stringify(toolHeavyRequest()),
  });
  await res.arrayBuffer();
}

describe("proxy — Theo policy hot-reload", () => {
  let proxy: MeshProxy | undefined;
  let upstream: { server: Server; url: string } | undefined;
  afterEach(async () => { await proxy?.close(); upstream?.server.close(); });

  it("re-reads the reduction per request, so a published policy takes effect without restart", async () => {
    const seen: AnyObject[] = [];
    upstream = await stubUpstream(seen);
    const ledgerDir = mkdtempSync(join(tmpdir(), "mesh-hot-"));
    // The getter is the live policy: lossless-only at first, then it adds a lossy
    // description-trim — exactly what Theo publishing a proven lever would do.
    let live: MeshTokenReductionConfig = {};
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
      tokenReduction: () => live,
    });

    await post(proxy, "app-hot");
    const firstSize = JSON.stringify(seen.at(-1)).length;

    live = { toolSchemas: { descriptions: "truncate" } }; // Theo "publishes" the lever
    await post(proxy, "app-hot");
    const secondSize = JSON.stringify(seen.at(-1)).length;

    // The forwarded request shrank once the new policy was live — no restart.
    expect(secondSize).toBeLessThan(firstSize);
  });
});

describe("proxy — opt-in request capture for the gate", () => {
  let proxy: MeshProxy | undefined;
  let upstream: { server: Server; url: string } | undefined;
  afterEach(async () => { await proxy?.close(); upstream?.server.close(); });

  it("captures original requests to a local file, bounded by the limit, off by default", async () => {
    const seen: AnyObject[] = [];
    upstream = await stubUpstream(seen);
    const ledgerDir = mkdtempSync(join(tmpdir(), "mesh-cap-"));
    const capturePath = join(ledgerDir, "capture", "requests.jsonl");
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
      requestCapture: { path: capturePath, limit: 2 },
    });

    await post(proxy, "app-cap");
    await post(proxy, "app-cap");
    await post(proxy, "app-cap"); // third exceeds the limit of 2

    await waitFor(() => existsSync(capturePath) && readFileSync(capturePath, "utf8").trim().split("\n").length >= 2);
    const lines = readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2); // limit respected
    const row = JSON.parse(lines[0]!) as { request?: { model?: string } };
    expect(row.request?.model).toBe("claude-sonnet-5-5-20260514"); // the ORIGINAL request body
  });

  it("bounds the capture file by maxBytes, across many requests", async () => {
    const seen: AnyObject[] = [];
    upstream = await stubUpstream(seen);
    const ledgerDir = mkdtempSync(join(tmpdir(), "mesh-capbytes-"));
    const capturePath = join(ledgerDir, "requests.jsonl");
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
      requestCapture: { path: capturePath, limit: 100, maxBytes: 3000 },
    });
    for (let i = 0; i < 10; i += 1) await post(proxy, "app-cb");
    await waitFor(() => existsSync(capturePath));
    const size = statSync(capturePath).size;
    const lines = readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean);
    expect(size).toBeLessThanOrEqual(3000); // never grows past the cap
    expect(lines.length).toBeGreaterThanOrEqual(1); // but still captured something
    expect(lines.length).toBeLessThan(10); // and the cap stopped it well short of all 10
  });

  it("writes nothing when capture is not configured", async () => {
    const seen: AnyObject[] = [];
    upstream = await stubUpstream(seen);
    const ledgerDir = mkdtempSync(join(tmpdir(), "mesh-nocap-"));
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
    });
    await post(proxy, "app-nocap");
    await sleep(100);
    // No capture file anywhere under the ledger dir.
    expect(existsSync(join(ledgerDir, "capture", "requests.jsonl"))).toBe(false);
  });
});
