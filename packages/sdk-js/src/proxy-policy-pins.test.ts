import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMeshProxy, type MeshProxy } from "./proxy.js";
import type { MeshTokenReductionConfig } from "./reduce-request.js";

/**
 * Through the real proxy: a policy that changes while a conversation is in
 * flight does not change what that conversation's provider receives.
 */

type AnyObject = Record<string, any>;

function stubUpstream(seen: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_stub", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

const TOOLS = [{
  name: "search",
  description: "Search the corpus and return the most relevant passages for the query.",
  input_schema: { $schema: "https://json-schema.org/draft/2020-12/schema", title: "SearchInput", type: "object", properties: { q: { type: "string", title: "q" } }, required: ["q"] },
}];
const RAW_TOOLS = JSON.stringify(TOOLS);

function turnOf(opening: string, turn: number, extra: AnyObject = {}): AnyObject {
  const messages: AnyObject[] = [{ role: "user", content: opening }];
  for (let done = 1; done < turn; done += 1) {
    messages.push({ role: "assistant", content: `Answer ${done}.` });
    messages.push({ role: "user", content: `Follow-up ${done}.` });
  }
  return { model: "claude-sonnet-5-5", max_tokens: 100, system: "You are terse.", tools: TOOLS, messages, ...extra };
}

async function send(proxy: MeshProxy, body: AnyObject): Promise<string> {
  const text = JSON.stringify(body);
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "caller-key", "x-mesh-application": "app-pins" },
    body: text,
  });
  await response.arrayBuffer();
  expect(response.status).toBe(200);
  return text;
}

const OFF: MeshTokenReductionConfig = { toolSchemas: false, duplicateContext: false };
const SCHEMAS: MeshTokenReductionConfig = { toolSchemas: true, duplicateContext: false };
const toolsOf = (forwarded: string): string => JSON.stringify((JSON.parse(forwarded) as AnyObject).tools);

describe("proxy — a conversation keeps the policy it started with", () => {
  let proxy: MeshProxy | undefined;
  let upstream: { server: Server; url: string } | undefined;
  afterEach(async () => { await proxy?.close(); proxy = undefined; upstream?.server.close(); });

  it("a lever published mid-conversation reaches new conversations, not the one in flight", async () => {
    const seen: string[] = [];
    upstream = await stubUpstream(seen);
    let live = OFF;
    proxy = await startMeshProxy({ ledgerDirectory: mkdtempSync(join(tmpdir(), "mesh-pin-")), anthropicUpstream: upstream.url, tokenReduction: () => live });

    await send(proxy, turnOf("Find the clause.", 1));
    expect(toolsOf(seen.at(-1)!)).toBe(RAW_TOOLS);

    live = SCHEMAS; // Theo publishes tool-schema compaction
    await send(proxy, turnOf("Find the clause.", 2));
    expect(toolsOf(seen.at(-1)!)).toBe(RAW_TOOLS); // the cached prefix is byte-identical
    await send(proxy, turnOf("Find the clause.", 3));
    expect(toolsOf(seen.at(-1)!)).toBe(RAW_TOOLS);

    await send(proxy, turnOf("A new question.", 1));
    expect(toolsOf(seen.at(-1)!).length).toBeLessThan(RAW_TOOLS.length); // the new conversation gets the lever
    await send(proxy, turnOf("A new question.", 2));
    expect(toolsOf(seen.at(-1)!).length).toBeLessThan(RAW_TOOLS.length);
  });

  it("and the other way round: a lever switched off stays on for the conversation that started with it", async () => {
    const seen: string[] = [];
    upstream = await stubUpstream(seen);
    let live = SCHEMAS;
    proxy = await startMeshProxy({ ledgerDirectory: mkdtempSync(join(tmpdir(), "mesh-pin-")), anthropicUpstream: upstream.url, tokenReduction: () => live });
    await send(proxy, turnOf("Find the clause.", 1));
    const compacted = toolsOf(seen.at(-1)!);
    live = OFF;
    await send(proxy, turnOf("Find the clause.", 2));
    expect(toolsOf(seen.at(-1)!)).toBe(compacted);
  });

  it("with pinning switched off, a changed policy applies to the very next request", async () => {
    const seen: string[] = [];
    upstream = await stubUpstream(seen);
    let live = OFF;
    proxy = await startMeshProxy({ ledgerDirectory: mkdtempSync(join(tmpdir(), "mesh-pin-")), anthropicUpstream: upstream.url, tokenReduction: () => live, conversationPolicyPins: false });
    await send(proxy, turnOf("Find the clause.", 1));
    live = SCHEMAS;
    await send(proxy, turnOf("Find the clause.", 2));
    expect(toolsOf(seen.at(-1)!).length).toBeLessThan(RAW_TOOLS.length);
  });

  it("started under a client that is already mid-conversation with its own cache, the proxy forwards it byte for byte", async () => {
    const seen: string[] = [];
    upstream = await stubUpstream(seen);
    const everything: MeshTokenReductionConfig = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, toolResultJson: true };
    proxy = await startMeshProxy({ ledgerDirectory: mkdtempSync(join(tmpdir(), "mesh-pin-")), anthropicUpstream: upstream.url, tokenReduction: () => everything });

    const cached = { system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } }] };
    // The first request the proxy ever sees is turn 4 of a cached conversation.
    const sent4 = await send(proxy, turnOf("Long-running session.", 4, cached));
    expect(seen.at(-1)).toBe(sent4);
    const sent5 = await send(proxy, turnOf("Long-running session.", 5, cached));
    expect(seen.at(-1)).toBe(sent5);

    // A conversation that starts under the proxy gets the policy.
    await send(proxy, turnOf("Fresh session.", 1, cached));
    expect(toolsOf(seen.at(-1)!).length).toBeLessThan(RAW_TOOLS.length);
  });

  it("the pins survive a restart, so a restarted proxy with a new policy does not re-write a conversation in flight", async () => {
    const seen: string[] = [];
    upstream = await stubUpstream(seen);
    const ledgerDirectory = mkdtempSync(join(tmpdir(), "mesh-pin-"));
    const common = { ledgerDirectory, anthropicUpstream: upstream.url, blindFeaturesKey: "test-deployment-key" };

    proxy = await startMeshProxy({ ...common, tokenReduction: () => SCHEMAS });
    await send(proxy, turnOf("A recognisable opening sentence.", 1));
    const compacted = toolsOf(seen.at(-1)!);
    expect(compacted.length).toBeLessThan(RAW_TOOLS.length);
    await proxy.close();

    const pinFile = join(ledgerDirectory, "conversation-pins.json");
    expect(existsSync(pinFile)).toBe(true);
    expect(readFileSync(pinFile, "utf8")).not.toContain("recognisable");

    // The proxy comes back (an update, a reboot) with a different policy.
    proxy = await startMeshProxy({ ...common, tokenReduction: () => OFF });
    await send(proxy, turnOf("A recognisable opening sentence.", 2));
    expect(toolsOf(seen.at(-1)!)).toBe(compacted); // same bytes as before the restart
    await send(proxy, turnOf("Started after the restart.", 1));
    expect(toolsOf(seen.at(-1)!)).toBe(RAW_TOOLS);
  });
});
