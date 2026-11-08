import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { startMeshProxy, usageFromSse, type MeshProxy } from "./proxy.js";

type AnyObject = Record<string, any>;

/**
 * Stub provider: records what it was sent, answers /v1/messages with an
 * Anthropic-shaped JSON (or SSE when the request asked to stream) and
 * /v1/responses with an OpenAI-shaped JSON. Usage is proportional to the
 * request it actually received, so reductions are visible in the ledger.
 */
function stubUpstream(seen: AnyObject[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnyObject;
      seen.push({ path: req.url, headers: req.headers, body });
      const inputTokens = Math.ceil(JSON.stringify(body).length / 4);
      if (req.url === "/v1/messages" && body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "ok" } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\n`);
        res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        return;
      }
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_stub",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
        return;
      }
      if (req.url === "/v1/responses") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp_stub",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: inputTokens, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
        }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected path ${req.url}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("MESH proxy mode", () => {
  const seen: AnyObject[] = [];
  let upstream: { server: Server; url: string };
  let proxy: MeshProxy;
  let ledgerDir: string;

  beforeAll(async () => {
    upstream = await stubUpstream(seen);
    ledgerDir = mkdtempSync(join(tmpdir(), "mesh-proxy-"));
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
    });
  });

  afterAll(async () => {
    await proxy.close();
    upstream.server.close();
  });

  const duplicated = `${"Clause 4471 applies to every refund older than thirty days and must be cited in full. ".repeat(3)}`;

  it("reduces the request before forwarding and returns the provider's bytes untouched", async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-mesh-application": "app-a" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5-20260514",
        max_tokens: 100,
        system: "You are terse.",
        messages: [{ role: "user", content: `${duplicated}\n\n${duplicated}\n\nSummarise.` }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyObject;
    expect(body.id).toBe("msg_stub");
    expect(body.content[0].text).toBe("ok");

    const sent = seen[seen.length - 1]!;
    // The caller's own credentials passed through verbatim; MESH added nothing.
    expect(sent.headers["x-api-key"]).toBe("caller-key");
    expect(sent.headers["x-mesh-application"]).toBeUndefined();
    // The duplicate block was removed before the provider saw the request.
    const wire = JSON.stringify(sent.body);
    expect(wire.split("Clause 4471").length - 1).toBeLessThan(6);
  });

  it("appends a priced, hash-chained ledger event per request, with estimated-baseline savings billed", async () => {
    const records = readFileSync(join(ledgerDir, "app-a-anthropic.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: records.length });
    const event = records[0]!.event;
    expect(event.pricingStatus).toBe("priced");
    expect(event.applicationId).toBe("app-a");
    const invoice = recomputeInvoice(records.map((r) => r.event));
    expect(invoice.netVerifiedSavingsUsd).toBeGreaterThan(0);
    expect(invoice.lineItems.some((line) => line.basis === "estimated-baseline")).toBe(true);
  });

  it("streams SSE through and prices the event from the stream's own usage", async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-mesh-application": "app-b" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5-20260514",
        max_tokens: 100,
        stream: true,
        system: "You are terse.",
        messages: [{ role: "user", content: "Hello." }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The SSE bytes reached the client intact.
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");

    const records = readFileSync(join(ledgerDir, "app-b-anthropic.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(1);
    const event = records[0]!.event;
    expect(event.pricingStatus).toBe("priced");
    // Output tokens came from the LAST message_delta, not message_start.
    expect(event.usage?.outputTokens).toBe(7);
  });

  it("forwards OpenAI-shaped requests to the OpenAI upstream path", async () => {
    const res = await fetch(`${proxy.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
      body: JSON.stringify({ model: "gpt-5", input: [{ role: "user", content: "Hello." }] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AnyObject).id).toBe("resp_stub");
    const sent = seen[seen.length - 1]!;
    expect(sent.path).toBe("/v1/responses");
    expect(sent.headers.authorization).toBe("Bearer caller-key");
  });

  it("rejects paths it does not proxy with a helpful message, touching nothing", async () => {
    const res = await fetch(`${proxy.url}/v1/other`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as AnyObject).error).toContain("base_url");
  });

  it("rejects a non-JSON body without contacting the upstream", async () => {
    const before = seen.length;
    const res = await fetch(`${proxy.url}/v1/messages`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect(seen.length).toBe(before);
  });
});

describe("usageFromSse", () => {
  it("returns undefined for a stream with no readable usage, never a guess", () => {
    expect(usageFromSse("anthropic", "data: {\"type\":\"ping\"}\n\n")).toBeUndefined();
    expect(usageFromSse("openai", "data: [DONE]\n\n")).toBeUndefined();
  });

  it("reads OpenAI Responses usage from response.completed", () => {
    const sse = `data: ${JSON.stringify({ type: "response.created", response: {} })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 }, service_tier: "flex" } })}\n\n`;
    const shaped = usageFromSse("openai", sse) as AnyObject;
    expect(shaped.usage.input_tokens).toBe(10);
    expect(shaped.service_tier).toBe("flex");
  });
});

describe("MESH proxy hardening (pre-launch security review)", () => {
  const seen: Array<Record<string, any>> = [];
  let upstream: { server: Server; url: string };
  let proxy: MeshProxy;
  let ledgerDir: string;

  beforeAll(async () => {
    upstream = await stubUpstream(seen);
    ledgerDir = mkdtempSync(join(tmpdir(), "mesh-proxy-sec-"));
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
    });
  });
  afterAll(async () => {
    await proxy.close();
    upstream.server.close();
  });

  it("never forwards the other provider's credential (key scoping)", async () => {
    seen.length = 0;
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-demo",
        "authorization": "Bearer sk-openai-demo",
        "x-mesh-application": "scoping-test",
      },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    const anthropicCall = seen.find((s) => s.path === "/v1/messages")!;
    expect(anthropicCall.headers["x-api-key"]).toBe("sk-ant-demo");
    expect(anthropicCall.headers.authorization).toBeUndefined();
    expect(anthropicCall.headers["x-mesh-application"]).toBeUndefined();

    seen.length = 0;
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-demo",
        "authorization": "Bearer sk-openai-demo",
      },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });
    const openaiCall = seen[0]!;
    expect(openaiCall.headers.authorization).toBe("Bearer sk-openai-demo");
    expect(openaiCall.headers["x-api-key"]).toBeUndefined();
  });

  it("keeps Anthropic bearer-only auth working (no x-api-key present)", async () => {
    seen.length = 0;
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer anthropic-oauth" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(seen[0]!.headers.authorization).toBe("Bearer anthropic-oauth");
  });

  it("rejects oversized bodies with 413 instead of buffering them", async () => {
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"model":"claude-sonnet-5-5","pad":"${"x".repeat(65 * 1024 * 1024)}"}`,
    }).catch(() => undefined);
    // Either a clean 413 or a dropped connection is acceptable; what must
    // never happen is the proxy buffering the whole body and answering 200.
    if (response !== undefined) expect([413, 400]).toContain(response.status);
  });

  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    // fetch() forbids overriding Host; speak raw HTTP to set it.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const r = request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "POST",
        path: "/v1/messages",
        headers: { "content-type": "application/json", host: "evil.example.com" },
      }, (response) => resolve(response.statusCode ?? 0));
      r.on("error", reject);
      r.end(JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
    });
    expect(status).toBe(403);
  });

  it("rejects cross-origin browser requests (CSRF-to-localhost)", async () => {
    // A browser driving a cross-origin request attaches Sec-Fetch-Site; a CLI
    // client sends none. Both same-site and cross-site must be refused.
    for (const site of ["cross-site", "same-site"]) {
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": site },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(403);
    }
  });

  it("shares one ledger (one chain) between raw app ids that sanitize alike", async () => {
    for (const raw of ["app one", "app_one"]) {
      await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-application": raw },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
    }
    const spool = readFileSync(join(ledgerDir, "app_one-anthropic.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
    expect(spool.length).toBe(2);
    expect(verifyLedgerChain(spool).ok).toBe(true);
  });

  it("aborts the upstream request when the client disconnects mid-stream", async () => {
    const abort = new AbortController();
    const started = fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: abort.signal,
    });
    // Cancel as soon as headers arrive; the proxy must survive and keep
    // serving (the stub stream is short, so this mainly asserts no crash and
    // no write-after-destroy taking the server down).
    try {
      const response = await started;
      abort.abort();
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      // aborted before headers — also fine
    }
    const after = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "still alive?" }] }),
    });
    expect(after.status).toBe(200);
  });
});

describe("output-waste metering in the proxy", () => {
  it("records re-emission diagnostics on large completions and flags byte-identical retries", async () => {
    const CONTEXT_LINE = "function computeTotals(rows) { return rows.reduce((s, r) => s + r.amount, 0); }";
    const echoServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        // Echo the code line many times (re-emission) plus novel prose.
        const echoed = Array.from({ length: 12 }, () => CONTEXT_LINE).join("\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_echo", type: "message", role: "assistant", model: "claude-sonnet-5-5",
          content: [{ type: "text", text: `Here is the file again:\n${echoed}\nAnd one novel closing remark.` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 500, output_tokens: 320, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
      });
    });
    await new Promise<void>((ready) => echoServer.listen(0, "127.0.0.1", () => ready()));
    const echoUrl = `http://127.0.0.1:${(echoServer.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "mesh-waste-"));
    const wasteProxy = await startMeshProxy({ ledgerDirectory: dir, anthropicUpstream: echoUrl });

    const body = JSON.stringify({
      model: "claude-sonnet-5-5", max_tokens: 400,
      system: "You are terse.",
      messages: [{ role: "user", content: `Fix this file:\n${CONTEXT_LINE}` }],
    });
    for (let round = 0; round < 2; round += 1) {
      await fetch(`${wasteProxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-application": "waste-test" },
        body,
      });
    }
    await wasteProxy.close();
    echoServer.closeAllConnections();
    echoServer.close();

    const records = readFileSync(join(dir, "waste-test-anthropic.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(2);
    const first = records[0]!.event as Record<string, any>;
    const second = records[1]!.event as Record<string, any>;
    expect(first.outputDiagnostics).toBeDefined();
    expect(first.outputDiagnostics.reEmittedOutputTokens).toBeGreaterThan(0);
    expect(first.outputDiagnostics.reEmittedCodeTokens).toBeGreaterThan(0);
    expect(first.outputDiagnostics.inspectedOutputTokens).toBeGreaterThan(first.outputDiagnostics.reEmittedOutputTokens);
    expect(first.duplicateOfRequestId).toBeUndefined();
    expect(second.duplicateOfRequestId).toBe(first.requestId);
    expect(verifyLedgerChain(records).ok).toBe(true);
  });
});

describe("MESH proxy — provably-blind learning stream", () => {
  const seen: AnyObject[] = [];
  let upstream: { server: Server; url: string };
  let proxy: MeshProxy;
  let ledgerDir: string;

  beforeAll(async () => {
    upstream = await stubUpstream(seen);
    ledgerDir = mkdtempSync(join(tmpdir(), "mesh-blind-"));
    proxy = await startMeshProxy({
      ledgerDirectory: ledgerDir,
      anthropicUpstream: upstream.url,
      openaiUpstream: upstream.url,
      blindFeaturesKey: "enclave-sealed-secret",
    });
  });

  afterAll(async () => {
    await proxy.close();
    upstream.server.close();
  });

  const SECRET = "PATIENT JANE DOE acute lymphoblastic leukaemia treatment plan";

  it("writes a features record that learns the structure but contains NO prompt content", async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-mesh-application": "blind-app" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5-20260514",
        max_tokens: 100,
        system: "You are a careful clinical assistant.",
        messages: [{ role: "user", content: SECRET }],
      }),
    });
    expect(res.status).toBe(200);

    const raw = readFileSync(join(ledgerDir, "blind-app-anthropic.features.jsonl"), "utf8").trim();
    // The sensitive prompt must appear NOWHERE in what the gateway persisted.
    expect(raw).not.toContain("JANE DOE");
    expect(raw.toLowerCase()).not.toContain("lymphoblastic");
    expect(raw).not.toContain("clinical assistant");

    const record = JSON.parse(raw.split("\n").at(-1)!) as AnyObject;
    // ...but the structure needed to calibrate levers is there.
    expect(record.features.provider).toBe("anthropic");
    expect(record.features.messageCount).toBe(1);
    expect(record.features.inputTokensApprox).toBeGreaterThan(0);
    expect(Array.isArray(record.features.blockHashes)).toBe(true);
    expect(record.features.blockHashes.length).toBeGreaterThan(0);
  });

  it("does not write any features file when no key is configured", async () => {
    // A second proxy with blind features OFF must produce no features spool.
    const dir = mkdtempSync(join(tmpdir(), "mesh-noblind-"));
    const p = await startMeshProxy({ ledgerDirectory: dir, anthropicUpstream: upstream.url, openaiUpstream: upstream.url });
    await fetch(`${p.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k", "x-mesh-application": "plain" },
      body: JSON.stringify({ model: "claude-sonnet-5-5-20260514", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    await p.close();
    expect(() => readFileSync(join(dir, "plain-anthropic.features.jsonl"), "utf8")).toThrow();
  });
});

describe("MESH proxy — shared-prefix fan-out serialization", () => {
  /**
   * A stub whose /v1/messages holds the FIRST request it sees for 150ms
   * before answering (modelling a real cache write's time to first byte),
   * then answers every later request immediately. Each request's own
   * arrival order is recorded so a test can assert on who was held.
   */
  function slowFirstUpstream(arrivals: number[]): Promise<{ server: Server; url: string }> {
    let first = true;
    const server = createServer((req, res) => {
      arrivals.push(Date.now());
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const respond = (): void => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "msg_stub",
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }));
        };
        if (first) {
          first = false;
          setTimeout(respond, 150);
        } else {
          respond();
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({ server, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  const requestFor = (tag: string): AnyObject => ({
    model: "claude-sonnet-5-5-20260514",
    max_tokens: 10,
    system: "shared system prompt",
    tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: `agent ${tag}` }],
  });

  it("holds concurrent same-prefix requests until the first upstream call is sent, when enabled", async () => {
    const arrivals: number[] = [];
    const slow = await slowFirstUpstream(arrivals);
    const dir = mkdtempSync(join(tmpdir(), "mesh-fanout-on-"));
    const p = await startMeshProxy({
      ledgerDirectory: dir,
      anthropicUpstream: slow.url,
      openaiUpstream: slow.url,
      serializeFanoutWrites: true,
    });

    const sendAt: number[] = [];
    const post = (tag: string): Promise<Response> => {
      sendAt.push(Date.now());
      return fetch(`${p.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify(requestFor(tag)),
      });
    };

    // Five requests sharing the same model+tools+system, dispatched together.
    const responses = await Promise.all(["a", "b", "c", "d", "e"].map((tag) => post(tag)));
    for (const response of responses) expect(response.status).toBe(200);

    await p.close();
    slow.server.close();

    // The upstream saw all five eventually, but not within the hold window:
    // the held four must not have reached the upstream until at least the
    // 150ms the first request's response was delayed by.
    expect(arrivals).toHaveLength(5);
    const first = arrivals[0]!;
    const held = arrivals.slice(1);
    for (const arrival of held) {
      expect(arrival - first).toBeGreaterThanOrEqual(140); // small margin for timer jitter
    }
  });

  it("does not hold anything when the flag is off (today's behaviour, unchanged)", async () => {
    const arrivals: number[] = [];
    const slow = await slowFirstUpstream(arrivals);
    const dir = mkdtempSync(join(tmpdir(), "mesh-fanout-off-"));
    const p = await startMeshProxy({
      ledgerDirectory: dir,
      anthropicUpstream: slow.url,
      openaiUpstream: slow.url,
      // serializeFanoutWrites omitted: default off.
    });

    const post = (tag: string): Promise<Response> =>
      fetch(`${p.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify(requestFor(tag)),
      });

    const dispatchedAt = Date.now();
    const responses = await Promise.all(["a", "b", "c", "d", "e"].map((tag) => post(tag)));
    for (const response of responses) expect(response.status).toBe(200);
    await p.close();
    slow.server.close();

    // All five reached the upstream essentially at once — no hold applied.
    expect(arrivals).toHaveLength(5);
    for (const arrival of arrivals) {
      expect(arrival - dispatchedAt).toBeLessThan(100);
    }
  });

  it("releases held requests even when the first upstream call errors (fails open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-fanout-err-"));
    // No server listening on this port: every request's fetch rejects.
    const deadPort = "http://127.0.0.1:1";
    const p = await startMeshProxy({
      ledgerDirectory: dir,
      anthropicUpstream: deadPort,
      openaiUpstream: deadPort,
      serializeFanoutWrites: true,
      fanoutHoldCapMs: 2_000,
    });

    const post = (tag: string): Promise<Response> =>
      fetch(`${p.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify(requestFor(tag)),
      });

    const startedAt = Date.now();
    const responses = await Promise.all(["a", "b"].map((tag) => post(tag)));
    const elapsedMs = Date.now() - startedAt;
    await p.close();

    // Both error out as 502s (upstream unreachable), and the second request
    // was released by the first's error path, not stuck until the 2s cap.
    for (const response of responses) expect(response.status).toBe(502);
    expect(elapsedMs).toBeLessThan(1_500);
  });
});
