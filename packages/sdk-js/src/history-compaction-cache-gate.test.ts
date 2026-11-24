import { describe, expect, it } from "vitest";
import { reduceRequest, type MeshTokenReductionConfig } from "./reduce-request.js";

/**
 * History compaction rewrites old turns. Where the provider is caching those
 * turns, the rewrite turns cheap reads into dear writes and the bill rises
 * while the token count falls. So compaction is withheld on a request whose
 * history is under a cache breakpoint, and says why.
 */

type Message = Record<string, unknown>;

const ANSWER = "The policy allows this within the billing period. Open the billing page and confirm the change. " +
  "A confirmation email follows within a minute. Nothing else is required from the customer.";
const SYSTEM = `You are a support assistant.\n${"Answer from the policy text only and cite the section. ".repeat(120)}`;
const SUPPRESSED = "stale-history-compaction-suppressed";
const COMPACTED = "stale-history-compaction";

function chat(turns: number, system: string = SYSTEM, model = "claude-sonnet-5-5"): Record<string, unknown> {
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: `Question ${turn + 1}: can I change seats on tier ${turn + 1}?` });
    if (turn < turns - 1) messages.push({ role: "assistant", content: `Answer ${turn + 1}. ${ANSWER}` });
  }
  return { model, max_tokens: 500, system, messages };
}

const levers = (request: unknown, config: MeshTokenReductionConfig): string[] =>
  reduceRequest(request, { toolSchemas: false, duplicateContext: false, ...config }).summary.changes.map((change) => change.lever);
const messagesAfter = (request: unknown, config: MeshTokenReductionConfig): unknown =>
  (reduceRequest(request, { toolSchemas: false, duplicateContext: false, ...config }).request as { messages: unknown }).messages;

describe("history compaction is withheld where the history is cached", () => {
  it("still compacts a conversation nothing is caching", () => {
    const request = chat(8);
    expect(levers(request, { historyCompaction: true })).toContain(COMPACTED);
    expect(levers(request, { historyCompaction: true })).not.toContain(SUPPRESSED);
    expect(JSON.stringify(messagesAfter(request, { historyCompaction: true })).length)
      .toBeLessThan(JSON.stringify(request.messages).length);
  });

  it("leaves the history alone when the caller placed a cache breakpoint in it, and says why", () => {
    const request = chat(8);
    const messages = request.messages as Message[];
    const last = messages[messages.length - 1]!;
    const marked = {
      ...request,
      messages: [
        ...messages.slice(0, -1),
        { ...last, content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }] },
      ],
    };
    const { request: reduced, summary } = reduceRequest(marked, { toolSchemas: false, duplicateContext: false, historyCompaction: true });
    expect((reduced as { messages: unknown }).messages).toEqual(marked.messages);
    const record = summary.changes.filter((change) => change.lever === SUPPRESSED);
    expect(record).toHaveLength(1);
    expect(record[0]!.lossless).toBe(true);
    expect(record[0]!.estimatedTokensSaved).toBe(0);
    expect(record[0]!.detail).toMatch(/caller placed a cache breakpoint inside the conversation/);
    expect(summary.changes.some((change) => change.lever === COMPACTED)).toBe(false);
  });

  it("leaves the history alone when the caller uses automatic caching", () => {
    const request: Record<string, unknown> = { ...chat(8), cache_control: { type: "ephemeral" } };
    expect(messagesAfter(request, { historyCompaction: true })).toEqual(request.messages);
    const { summary } = reduceRequest(request, { toolSchemas: false, duplicateContext: false, historyCompaction: true });
    expect(summary.changes.find((change) => change.lever === SUPPRESSED)!.detail).toMatch(/automatic prompt caching/);
  });

  it("leaves the history alone when Mesh's own stamp puts a breakpoint on the newest message", () => {
    const request = chat(8);
    const changes = levers(request, { historyCompaction: true, cacheTtl: "5m" });
    expect(changes).toContain(SUPPRESSED);
    expect(changes).not.toContain(COMPACTED);
    expect(changes).toContain("cache-ttl-5m");
    // Apart from the stamp's marker on the newest message, the history is what the caller sent.
    const reduced = messagesAfter(request, { historyCompaction: true, cacheTtl: "5m" }) as Message[];
    expect(reduced.slice(0, -1)).toEqual((request.messages as Message[]).slice(0, -1));
  });

  it("still compacts under the stamp when the history is not what the stamp caches", () => {
    // A clock at the top of the instructions: prefix repair moves it to the
    // end, so no breakpoint is placed behind it and the history is not cached.
    const clocked = chat(8, `Current time: 2026-11-23T09:00:00Z\n${SYSTEM}`);
    const withClock = levers(clocked, { historyCompaction: true, cacheTtl: "5m", repairCachePrefix: true });
    expect(withClock).toContain(COMPACTED);
    expect(withClock).not.toContain(SUPPRESSED);

    // A model the stamp never applies to.
    const other = chat(8, SYSTEM, "gpt-5");
    expect(levers(other, { historyCompaction: true, cacheTtl: "5m" })).toContain(COMPACTED);

    // The caller caches only the instructions: the stamp defers, and the history is not cached.
    const systemOnly = { ...chat(8), system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] };
    const changes = levers(systemOnly, { historyCompaction: true, cacheTtl: "5m" });
    expect(changes).toContain(COMPACTED);
    expect(changes).not.toContain(SUPPRESSED);
  });

  it("says nothing when compaction had nothing to do", () => {
    const short = { ...chat(2), cache_control: { type: "ephemeral" } };
    const { request: reduced, summary } = reduceRequest(short, { toolSchemas: false, duplicateContext: false, historyCompaction: true });
    expect(summary.changes).toEqual([]);
    expect(reduced).toBe(short);
  });

  it("allowUnderCache overrides the gate for a workload that has measured the trade", () => {
    const request = { ...chat(8), cache_control: { type: "ephemeral" } };
    const changes = levers(request, { historyCompaction: { allowUnderCache: true } });
    expect(changes).toContain(COMPACTED);
    expect(changes).not.toContain(SUPPRESSED);
  });

  it("the gate is the same decision on every turn, so a cached conversation stays byte-stable", () => {
    for (const turns of [4, 5, 6, 7, 8, 9]) {
      const request: Record<string, unknown> = { ...chat(turns), cache_control: { type: "ephemeral" } };
      expect(messagesAfter(request, { historyCompaction: true })).toEqual(request.messages);
    }
  });
});
