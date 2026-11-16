/**
 * The integration pathway, tested the way a tester meets it: the REAL client
 * libraries (the official Anthropic and OpenAI SDKs) pointed at the proxy by
 * changing only their base URL, against a stand-in provider that records what
 * reached it.
 *
 * The rule under test: pointing an application at MESH must never take a
 * working call away. The three generation endpoints are reduced and metered;
 * everything else an application already does through the same base URL
 * (token counting, embeddings, model lists, batches, file uploads, deletes)
 * has to arrive at the provider exactly as the client sent it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI, { toFile } from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMeshProxy, type MeshProxy } from "./proxy.js";

type Seen = { side: "anthropic" | "openai"; method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };

const sse = (events: Array<{ event?: string; data: unknown }>): string =>
  events.map(({ event, data }) =>
    `${event === undefined ? "" : `event: ${event}\n`}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join("");

const ANTHROPIC_MESSAGE = {
  id: "msg_stub", type: "message", role: "assistant", model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};
const ANTHROPIC_STREAM = sse([
  { event: "message_start", data: { type: "message_start", message: { ...ANTHROPIC_MESSAGE, content: [], stop_reason: null, usage: { input_tokens: 120, output_tokens: 1 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "o" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "k" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);
const CHAT_COMPLETION = {
  id: "chatcmpl-stub", object: "chat.completion", created: 1, model: "gpt-5",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 90, completion_tokens: 3, total_tokens: 93 },
};
const CHAT_STREAM = sse([
  { data: { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { role: "assistant", content: "o" }, finish_reason: null }] } },
  { data: { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [{ index: 0, delta: { content: "k" }, finish_reason: "stop" }] } },
  { data: { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: "gpt-5", choices: [], usage: { prompt_tokens: 90, completion_tokens: 3, total_tokens: 93 } } },
  { data: "[DONE]" },
]);
const RESPONSE = {
  id: "resp_stub", object: "response", created_at: 1, status: "completed", model: "gpt-5",
  output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
  usage: { input_tokens: 80, output_tokens: 3, total_tokens: 83 },
};

function standInProvider(side: Seen["side"], seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ side, method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const path = (req.url ?? "").split("?")[0]!;
      const json = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_stub", ...extra });
        res.end(JSON.stringify(payload));
      };
      const stream = (text: string): void => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(text);
      };
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>; } catch { /* not JSON */ }

      if (req.headers["x-test-fail"] === "429") {
        return json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "7" });
      }
      if (req.method === "POST" && path === "/v1/messages") return parsed.stream === true ? stream(ANTHROPIC_STREAM) : json(200, ANTHROPIC_MESSAGE);
      if (req.method === "POST" && path === "/v1/messages/count_tokens") return json(200, { input_tokens: 42 });
      if (req.method === "POST" && path === "/v1/messages/batches") return json(200, { id: "msgbatch_stub", type: "message_batch", processing_status: "in_progress", request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, created_at: "2026-11-16T00:00:00Z", expires_at: "2026-11-17T00:00:00Z", ended_at: null, archived_at: null, cancel_initiated_at: null, results_url: null });
      if (req.method === "POST" && path === "/v1/chat/completions") return parsed.stream === true ? stream(CHAT_STREAM) : json(200, CHAT_COMPLETION);
      if (req.method === "POST" && path === "/v1/responses") return json(200, RESPONSE);
      if (req.method === "POST" && path === "/v1/embeddings") return json(200, { object: "list", model: "text-embedding-3-small", data: [{ object: "embedding", index: 0, embedding: [0.25, -0.5] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
      if (req.method === "POST" && path === "/v1/files") return json(200, { id: "file-stub", object: "file", bytes: body.byteLength, created_at: 1, filename: "notes.jsonl", purpose: "batch" });
      if (req.method === "DELETE" && path === "/v1/files/file-stub") return json(200, { id: "file-stub", object: "file", deleted: true });
      if (req.method === "GET" && path === "/v1/models") {
        return side === "anthropic"
          ? json(200, { data: [{ id: "claude-sonnet-5-5", type: "model", display_name: "Claude Sonnet 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-sonnet-5-5", last_id: "claude-sonnet-5-5" })
          : json(200, { object: "list", data: [{ id: "gpt-5", object: "model", created: 1, owned_by: "openai" }] });
      }
      return json(404, { error: { message: `stand-in has no route for ${req.method} ${path}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    });
  });
}

const TOOLS = [{
  name: "create_order",
  description: "Create an order for a customer.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: { customer: { $ref: "#/$defs/Customer" }, quantity: { type: "integer" } },
    required: ["customer"],
    $defs: { Customer: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  },
}];

describe("the integration pathway — real client libraries through the proxy", () => {
  const seen: Seen[] = [];
  let anthropicSide: { server: Server; url: string };
  let openaiSide: { server: Server; url: string };
  let proxy: MeshProxy;
  let ledgerDirectory: string;
  let anthropic: Anthropic;
  let openai: OpenAI;

  beforeAll(async () => {
    anthropicSide = await standInProvider("anthropic", seen);
    openaiSide = await standInProvider("openai", seen);
    ledgerDirectory = mkdtempSync(join(tmpdir(), "mesh-clients-"));
    proxy = await startMeshProxy({
      port: 0,
      ledgerDirectory,
      anthropicUpstream: anthropicSide.url,
      openaiUpstream: openaiSide.url,
    });
    // The only change a tester makes: the base URL. Keys are their own.
    anthropic = new Anthropic({ apiKey: "sk-ant-test-not-real", baseURL: proxy.url, maxRetries: 0 });
    openai = new OpenAI({ apiKey: "sk-test-not-real", baseURL: `${proxy.url}/v1`, maxRetries: 0 });
  });
  afterAll(async () => {
    await proxy.close();
    anthropicSide.server.close();
    openaiSide.server.close();
    rmSync(ledgerDirectory, { recursive: true, force: true });
  });
  beforeEach(() => { seen.length = 0; });

  const last = (): Seen => seen[seen.length - 1]!;
  const ledgerEvents = (): Array<Record<string, unknown>> =>
    readdirSync(ledgerDirectory).filter((name) => name.endsWith(".jsonl") && !name.includes(".features."))
      .flatMap((name) => readFileSync(join(ledgerDirectory, name), "utf8").trim().split("\n").filter(Boolean))
      .map((line) => (JSON.parse(line) as { event: Record<string, unknown> }).event);

  describe("Anthropic SDK", () => {
    it("messages.create returns the provider's message, with the caller's key passed through", async () => {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-5-5", max_tokens: 64, tools: TOOLS,
        messages: [{ role: "user", content: "Order two for Ada." }],
      });
      expect(message.content[0]).toMatchObject({ type: "text", text: "ok" });
      expect(last().side).toBe("anthropic");
      // The current SDK sends the key as a bearer token, older ones as x-api-key.
      expect([last().headers.authorization, last().headers["x-api-key"]]).toContain(
        last().headers["x-api-key"] === undefined ? "Bearer sk-ant-test-not-real" : "sk-ant-test-not-real",
      );
      expect(last().headers["anthropic-version"]).toBeDefined();
      const sent = JSON.parse(last().body.toString("utf8")) as { tools: Array<{ input_schema: Record<string, unknown> }> };
      expect(sent.tools[0]!.input_schema.$defs).toEqual(TOOLS[0]!.input_schema.$defs);
      expect(sent.tools[0]!.input_schema.$schema).toBeUndefined();
    });

    it("messages.stream delivers every event and the final message", async () => {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-5-5", max_tokens: 64, messages: [{ role: "user", content: "Say ok." }],
      });
      let text = "";
      stream.on("text", (delta) => { text += delta; });
      const final = await stream.finalMessage();
      expect(text).toBe("ok");
      expect(final.usage.output_tokens).toBe(5);
    });

    it("beta.messages.create keeps its beta header", async () => {
      await anthropic.beta.messages.create({
        model: "claude-sonnet-5-5", max_tokens: 64, betas: ["context-management-2025-06-27"],
        messages: [{ role: "user", content: "Say ok." }],
      });
      expect(String(last().headers["anthropic-beta"])).toContain("context-management-2025-06-27");
    });

    it("keeps the query string on a generation request (Claude Code sends /v1/messages?beta=true)", async () => {
      const response = await fetch(`${proxy.url}/v1/messages?beta=true`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-test-not-real", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "x" }] }),
      });
      expect(response.status).toBe(200);
      expect(last().url).toBe("/v1/messages?beta=true");
    });

    it("messages.countTokens reaches the provider (Claude Code calls this constantly)", async () => {
      const count = await anthropic.messages.countTokens({
        model: "claude-sonnet-5-5", messages: [{ role: "user", content: "How long is this?" }],
      });
      expect(count.input_tokens).toBe(42);
      expect(last().url).toBe("/v1/messages/count_tokens");
      expect(last().side).toBe("anthropic");
    });

    it("models.list goes to Anthropic, not OpenAI", async () => {
      const page = await anthropic.models.list();
      expect(page.data[0]!.id).toBe("claude-sonnet-5-5");
      // An Anthropic credential must never be sent to the OpenAI upstream.
      expect(seen.every((request) => request.side === "anthropic")).toBe(true);
    });

    it("an older client that sends x-api-key is also routed to Anthropic, without a stray bearer", async () => {
      const response = await fetch(`${proxy.url}/v1/models`, {
        headers: { "x-api-key": "sk-ant-test-not-real", authorization: "Bearer sk-openai-must-not-travel" },
      });
      expect(response.status).toBe(200);
      expect(last().side).toBe("anthropic");
      expect(last().headers.authorization).toBeUndefined();
    });

    it("models.list still goes to Anthropic for a subscription login (bearer token, no x-api-key)", async () => {
      const oauth = new Anthropic({ authToken: "oauth-test-not-real", apiKey: null, baseURL: proxy.url, maxRetries: 0 });
      const page = await oauth.models.list();
      expect(page.data[0]!.id).toBe("claude-sonnet-5-5");
      expect(last().side).toBe("anthropic");
      expect(last().headers.authorization).toBe("Bearer oauth-test-not-real");
    });

    it("messages.batches.create reaches the provider untouched", async () => {
      const params = { custom_id: "a", params: { model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user" as const, content: "hi" }] } };
      const batch = await anthropic.messages.batches.create({ requests: [params] });
      expect(batch.id).toBe("msgbatch_stub");
      expect(JSON.parse(last().body.toString("utf8"))).toEqual({ requests: [params] });
    });

    it("a provider error arrives as the provider's own error, status and retry header", async () => {
      const failing = new Anthropic({
        apiKey: "sk-ant-test-not-real", baseURL: proxy.url, maxRetries: 0,
        defaultHeaders: { "x-test-fail": "429" },
      });
      const error = await failing.messages.create({
        model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }],
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Anthropic.RateLimitError);
      expect((error as InstanceType<typeof Anthropic.RateLimitError>).headers.get("retry-after")).toBe("7");
    });
  });

  describe("OpenAI SDK", () => {
    it("chat.completions.create returns the provider's completion", async () => {
      const completion = await openai.chat.completions.create({
        model: "gpt-5", messages: [{ role: "user", content: "Say ok." }],
      });
      expect(completion.choices[0]!.message.content).toBe("ok");
      expect(last().side).toBe("openai");
      expect(last().headers.authorization).toBe("Bearer sk-test-not-real");
      expect(last().headers["x-api-key"]).toBeUndefined();
    });

    it("chat.completions streaming delivers every chunk", async () => {
      const stream = await openai.chat.completions.create({
        model: "gpt-5", messages: [{ role: "user", content: "Say ok." }],
        stream: true, stream_options: { include_usage: true },
      });
      let text = "";
      for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
      expect(text).toBe("ok");
    });

    it("responses.create returns the provider's response", async () => {
      const response = await openai.responses.create({ model: "gpt-5", input: "Say ok." });
      expect(response.output_text).toBe("ok");
    });

    it("embeddings.create reaches the provider (every retrieval app needs this)", async () => {
      const result = await openai.embeddings.create({ model: "text-embedding-3-small", input: "refund policy", encoding_format: "float" });
      expect(result.data[0]!.embedding).toEqual([0.25, -0.5]);
      expect(JSON.parse(last().body.toString("utf8"))).toEqual({ model: "text-embedding-3-small", input: "refund policy", encoding_format: "float" });
    });

    it("models.list goes to the OpenAI side", async () => {
      const page = await openai.models.list();
      expect(page.data[0]!.id).toBe("gpt-5");
      expect(seen.every((request) => request.side === "openai")).toBe(true);
    });

    it("a multipart file upload arrives byte for byte, and a delete is forwarded", async () => {
      const content = Buffer.from('{"custom_id":"a"}\n\u0000\u0001binary-safe\n');
      const file = await openai.files.create({ file: await toFile(content, "notes.jsonl"), purpose: "batch" });
      expect(file.id).toBe("file-stub");
      expect(String(last().headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
      expect(last().body.includes(content)).toBe(true);

      const deleted = await openai.files.delete("file-stub");
      expect(deleted.deleted).toBe(true);
      expect(last().method).toBe("DELETE");
    });
  });

  describe("what is metered", () => {
    it("only generation requests write ledger events; passthrough calls write none", async () => {
      const before = ledgerEvents().length;
      await anthropic.messages.countTokens({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }] });
      await openai.embeddings.create({ model: "text-embedding-3-small", input: "x" });
      await anthropic.models.list();
      expect(ledgerEvents().length).toBe(before);

      await anthropic.messages.create({ model: "claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "x" }] });
      const events = ledgerEvents();
      expect(events.length).toBe(before + 1);
      const anthropicEvents = events.filter((event) => event.provider === "anthropic");
      expect(anthropicEvents[anthropicEvents.length - 1]).toMatchObject({
        status: "succeeded", usage: { inputTokens: 120, outputTokens: 5 },
      });
    });

    it("a request no lever changes is forwarded byte for byte", async () => {
      // Numbers a JSON round-trip would rewrite: 1.0 -> 1, and an integer past 2^53.
      const raw = '{"model":"claude-sonnet-5-5","max_tokens":16,"temperature":1.0,"metadata":{"user_id":"u"},' +
        '"messages":[{"role":"user","content":"id 9007199254740993 \\u00e9"}],"x_trace":9007199254740993}';
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-test-not-real", "anthropic-version": "2023-06-01" },
        body: raw,
      });
      expect(response.status).toBe(200);
      expect(last().body.toString("utf8")).toBe(raw);
    });
  });
});
