import { describe, expect, it } from "vitest";
import { approximateTokenCount } from "../../core/dist/src/index.js";
import { withMesh } from "./openai.js";
import {
  capToolResultBody,
  digestStaleBody,
  reduceRequest,
  type MeshReductionSummary,
} from "./reduce-request.js";

const LONG_DESCRIPTION =
  "Look up a record set for a customer account. Use this when the customer asks about historical activity in " +
  "this subsystem. Returns a paginated list ordered by creation time descending.";

const BLOCK =
  "Knowledge base article 4471: Refunds issued to a closed card are returned to the original payment method " +
  "where the issuer supports it, and otherwise credited to the customer wallet within one business day.";

function toolCatalogue(count = 2): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "function",
    function: {
      name: `lookup_${index}`,
      description: LONG_DESCRIPTION,
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { accountId: { type: "string", title: "accountId", description: "Account identifier." } },
        required: ["accountId"],
      },
    },
  }));
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-5",
    instructions: "You are a support agent.",
    tools: toolCatalogue(),
    input: [{ role: "user", content: "Why was my refund delayed?" }],
    ...overrides,
  };
}

describe("reduceRequest", () => {
  it("keeps tool descriptions by default, so the default path cannot change tool choice", () => {
    const { request: reduced, summary } = reduceRequest(request(), { toolSchemas: true });
    expect(JSON.stringify(reduced)).toContain("paginated list");
    expect(summary.changes.every((change) => change.lossless)).toBe(true);
    expect(summary.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("removes schema plumbing the model never reads", () => {
    const { request: reduced } = reduceRequest(request(), { toolSchemas: true });
    expect(JSON.stringify(reduced)).not.toContain("$schema");
  });

  it("trims descriptions only when explicitly asked, and reports it as lossy", () => {
    const { summary } = reduceRequest(request(), {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 8 },
    });
    const trim = summary.changes.find((change) => change.lever === "tool-schema-description-trim")!;
    expect(trim.lossless).toBe(false);
  });

  it("removes an exactly duplicated context block", () => {
    const withDuplicate = request({
      input: [{ role: "user", content: `${BLOCK}\n\n${BLOCK}\n\nWhy was my refund delayed?` }],
    });
    const { request: reduced } = reduceRequest(withDuplicate, { duplicateContext: true });
    const occurrences = JSON.stringify(reduced).split("article 4471").length - 1;
    expect(occurrences).toBe(1);
  });

  it("removes an exactly duplicated context block from an Anthropic-shaped request too", () => {
    const anthropicShaped = {
      model: "claude-sonnet-5-5-20260514",
      system: "You are a support agent.",
      messages: [{ role: "user", content: `${BLOCK}\n\n${BLOCK}\n\nWhy was my refund delayed?` }],
      max_tokens: 400,
    };
    const { request: reduced, summary } = reduceRequest(anthropicShaped, { duplicateContext: true });
    const occurrences = JSON.stringify(reduced).split("article 4471").length - 1;
    expect(occurrences).toBe(1);
    expect(summary.changes.some((change) => change.lever === "duplicate-context-removal")).toBe(true);
  });

  it("moves a leading clock out of the prefix without deleting it", () => {
    const withClock = request({ instructions: "Current time: 2026-10-08T09:14:22Z\nYou are a support agent." });
    const { request: reduced, summary } = reduceRequest(withClock, { repairCachePrefix: true });
    const instructions = String((reduced as Record<string, unknown>).instructions);
    expect(instructions.startsWith("You are a support agent.")).toBe(true);
    // Reordered, not removed: the model still sees the time.
    expect(instructions).toContain("Current time: 2026-10-08T09:14:22Z");
    const repair = summary.changes.find((change) => change.lever === "cache-prefix-repair")!;
    expect(repair.lossless).toBe(true);
    expect(repair.estimatedTokensSaved).toBe(0);
  });

  it("moves a leading request id out of the prefix too", () => {
    const withId = request({
      instructions: "Request: 7f3b9c2a-1d4e-4a8b-9c3d-2e5f6a7b8c9d\nYou are a support agent.",
    });
    const { request: reduced } = reduceRequest(withId, { repairCachePrefix: true });
    expect(String((reduced as Record<string, unknown>).instructions)
      .startsWith("You are a support agent.")).toBe(true);
  });

  it("leaves a timestamp deep in the prompt alone, since it is not what ends the prefix", () => {
    const body = Array.from({ length: 20 }, (_, index) => `Rule ${index}.`).join("\n");
    const deep = request({ instructions: `You are a support agent.\n${body}\nAs at 2026-10-08T09:14:22Z.` });
    const { request: reduced } = reduceRequest(deep, { repairCachePrefix: true });
    expect(String((reduced as Record<string, unknown>).instructions).trimEnd())
      .toMatch(/As at 2026-10-08T09:14:22Z\.$/);
  });

  it("sets an output cap only when the caller has not", () => {
    const capped = reduceRequest(request(), { maxOutputTokens: 500 });
    expect((capped.request as Record<string, unknown>).max_output_tokens).toBe(500);

    const alreadySet = reduceRequest(request({ max_output_tokens: 2_000 }), { maxOutputTokens: 500 });
    expect((alreadySet.request as Record<string, unknown>).max_output_tokens).toBe(2_000);
  });

  it("reports an output cap as lossy, because it truncates", () => {
    const { summary } = reduceRequest(request(), { maxOutputTokens: 500 });
    expect(summary.changes.find((change) => change.lever === "output-cap")!.lossless).toBe(false);
  });

  it("returns the original object untouched when there is nothing to do", () => {
    const original = { model: "gpt-5", input: "hello" };
    const { request: reduced, summary } = reduceRequest(original, { toolSchemas: true });
    expect(reduced).toBe(original);
    expect(summary.changes).toHaveLength(0);
  });

  it("never mutates the caller's request", () => {
    const original = request();
    const snapshot = JSON.stringify(original);
    reduceRequest(original, { toolSchemas: true, duplicateContext: true, repairCachePrefix: true });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("returns the request unchanged rather than throwing on a shape it cannot read", () => {
    for (const bad of ["a string", 42, null, undefined, [1, 2]]) {
      const { request: reduced, summary } = reduceRequest(bad, { toolSchemas: true });
      expect(reduced).toBe(bad);
      expect(summary.skipped).toBe(true);
    }
  });

  it("skips rather than throws on an invalid output cap", () => {
    const { request: reduced, summary } = reduceRequest(request(), { maxOutputTokens: 0 });
    expect(summary.skipped).toBe(true);
    expect(summary.skippedReason).toMatch(/positive integer/);
    expect(reduced).toEqual(request());
  });

  it("hands the summary to onReduction", () => {
    const seen: MeshReductionSummary[] = [];
    reduceRequest(request(), { toolSchemas: true, onReduction: (summary) => seen.push(summary) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.estimatedTokensSaved).toBeGreaterThan(0);
  });
});

describe("cross-turn memory dedup", () => {
  const MEMORY =
    "AGENT MEMORY (persistent): user prefers metric units; deploy window is 14:00-16:00 UTC; the staging DB is " +
    "read-only on Fridays; always page the on-call before schema changes. ".repeat(4);

  function memoryRequest(turns: number, model = "claude-sonnet-5-5"): Record<string, unknown> {
    const messages: unknown[] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      messages.push({ role: "user", content: `${MEMORY}\nTurn ${turn}: handle today's request ${turn}.` });
      messages.push({ role: "assistant", content: `Noted. Turn ${turn} handled.` });
    }
    return { model, max_tokens: 500, messages };
  }

  it("replaces the repeated memory block in later user turns and reports a lossy change", () => {
    const { request: reduced, summary } = reduceRequest(memoryRequest(4), { crossTurnMemoryDedup: true });
    const change = summary.changes.find((entry) => entry.lever === "cross-turn-memory-dedup")!;
    expect(change.lossless).toBe(false);
    expect(change.estimatedTokensSaved).toBeGreaterThan(0);
    const messages = (reduced as Record<string, unknown>).messages as Array<{ role: string; content: string }>;
    const userTurns = messages.filter((m) => m.role === "user");
    expect(userTurns[0]!.content).toContain("AGENT MEMORY");
    for (const turn of userTurns.slice(1)) {
      expect(turn.content).not.toContain("AGENT MEMORY");
      expect(turn.content).toMatch(/handle today's request \d\./);
    }
  });

  it("never touches assistant turns, even though they also repeat", () => {
    const { request: reduced } = reduceRequest(memoryRequest(4), { crossTurnMemoryDedup: true });
    const messages = (reduced as Record<string, unknown>).messages as Array<{ role: string; content: string }>;
    const assistantTurns = messages.filter((m) => m.role === "assistant");
    expect(assistantTurns.every((m) => m.content.startsWith("Noted."))).toBe(true);
  });

  it("is off by default", () => {
    const { summary } = reduceRequest(memoryRequest(4), {});
    expect(summary.changes.some((entry) => entry.lever === "cross-turn-memory-dedup")).toBe(false);
  });

  it("does nothing with a single user turn", () => {
    const original = memoryRequest(1);
    const { request: reduced, summary } = reduceRequest(original, { crossTurnMemoryDedup: true });
    expect(reduced).toEqual(original);
    expect(summary.changes).toHaveLength(0);
  });

  it("stays stable turn over turn: a masked user message rewrites to the exact same bytes next turn", () => {
    const four = reduceRequest(memoryRequest(4), { crossTurnMemoryDedup: true });
    const five = reduceRequest(memoryRequest(5), { crossTurnMemoryDedup: true });
    const fourMessages = (four.request as Record<string, unknown>).messages as unknown[];
    const fiveMessages = (five.request as Record<string, unknown>).messages as unknown[];
    expect(JSON.stringify(fiveMessages[0])).toBe(JSON.stringify(fourMessages[0]));
    for (let index = 2; index < fourMessages.length; index += 2) {
      expect(JSON.stringify(fiveMessages[index])).toBe(JSON.stringify(fourMessages[index]));
    }
  });

  it("respects a custom minimumBlockTokens and skips below it", () => {
    const { summary } = reduceRequest(memoryRequest(4), {
      crossTurnMemoryDedup: { minimumBlockTokens: 100_000 },
    });
    expect(summary.changes.some((entry) => entry.lever === "cross-turn-memory-dedup")).toBe(false);
  });

  it("skips the whole reduction on an invalid minimumBlockTokens", () => {
    const original = memoryRequest(4);
    const { request: reduced, summary } = reduceRequest(original, {
      crossTurnMemoryDedup: { minimumBlockTokens: -1 },
    });
    expect(reduced).toBe(original);
    expect(summary.skipped).toBe(true);
    expect(summary.skippedReason).toMatch(/positive integer/);
  });

  it("works on Responses-style `input` arrays too", () => {
    const input = [
      { role: "user", content: `${MEMORY}\nTurn 0: handle today's request 0.` },
      { role: "assistant", content: "Noted." },
      { role: "user", content: `${MEMORY}\nTurn 1: handle today's request 1.` },
    ];
    const { request: reduced } = reduceRequest({ model: "gpt-5", input }, { crossTurnMemoryDedup: true });
    const resultInput = (reduced as Record<string, unknown>).input as Array<{ role: string; content: string }>;
    expect(resultInput[2]!.content).not.toContain("AGENT MEMORY");
    expect(resultInput[2]!.content).toContain("Turn 1: handle today's request 1.");
  });

  it("extracts leading text from a {type:'text'} content block, leaving other blocks untouched", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: `${MEMORY}\nTurn 0: go.` }, { type: "image", source: "s0" }] },
      { role: "user", content: [{ type: "text", text: `${MEMORY}\nTurn 1: go.` }, { type: "image", source: "s1" }] },
    ];
    const { request: reduced } = reduceRequest(
      { model: "claude-sonnet-5-5", max_tokens: 100, messages },
      { crossTurnMemoryDedup: true },
    );
    const resultMessages = (reduced as Record<string, unknown>).messages as
      Array<{ content: Array<Record<string, unknown>> }>;
    expect(resultMessages[1]!.content[0]!.text).not.toContain("AGENT MEMORY");
    expect(resultMessages[1]!.content[1]).toEqual({ type: "image", source: "s1" });
  });
});

describe("fresh tool-result capping", () => {
  /** An oversized tool result shaped like the eval fixture: a headline carrying
   * the reference later turns depend on, verbose record sentences, one error
   * sentence and one file path, all of which must survive the cap. */
  function oversizedResult(task = 3, turn = 2): string {
    const lines = [
      `Lookup complete for account ${1000 + task}: 3 records found; latest reference R-${task}-${turn} ` +
      "with a pending adjustment awaiting supervisor approval.",
    ];
    for (let row = 0; row < 18; row += 1) {
      lines.push(
        `Record ${row} shows a settlement entry of ${row * 137 + task} pence captured on day ${(row % 28) + 1}, ` +
        "routed through the refunds subsystem, with reconciliation state nominal, no customer notification " +
        "sent, and two internal annotations noting routine supervisor review cadence for this category.",
      );
    }
    lines.push("One earlier retry failed with a transient timeout before the record was captured cleanly.");
    lines.push("The reconciliation ledger lives at ops/settlements/ledger.csv for later checks.");
    return lines.join(" ");
  }

  const MARKER = /\[mesh: \d+ chars of fresh tool-result detail capped\]/;

  it("keeps the headline with its latest reference, errors and file paths verbatim", () => {
    const capped = capToolResultBody(oversizedResult(), 600, approximateTokenCount);
    expect(capped).not.toBe(oversizedResult());
    expect(capped.length).toBeLessThan(oversizedResult().length);
    expect(capped).toContain("latest reference R-3-2");
    expect(capped).toContain("One earlier retry failed with a transient timeout");
    expect(capped).toContain("ops/settlements/ledger.csv");
    expect(capped).toMatch(MARKER);
  });

  it("is the identity at or under the threshold", () => {
    const small = "Lookup complete: latest reference R-1-1 with a pending adjustment.";
    expect(capToolResultBody(small, 600, approximateTokenCount)).toBe(small);
    const body = oversizedResult();
    expect(capToolResultBody(body, approximateTokenCount(body), approximateTokenCount)).toBe(body);
  });

  it("is idempotent: cap(cap(x)) === cap(x)", () => {
    const once = capToolResultBody(oversizedResult(), 600, approximateTokenCount);
    expect(capToolResultBody(once, 600, approximateTokenCount)).toBe(once);
  });

  it("is deterministic across calls", () => {
    expect(capToolResultBody(oversizedResult(), 600, approximateTokenCount))
      .toBe(capToolResultBody(oversizedResult(), 600, approximateTokenCount));
  });

  it("is byte-stable under stale compaction: digestStaleBody(cap(x)) === cap(x)", () => {
    const capped = capToolResultBody(oversizedResult(), 600, approximateTokenCount);
    expect(digestStaleBody(capped)).toBe(capped);
  });

  it("throws on a threshold under 64 or not an integer", () => {
    expect(() => capToolResultBody(oversizedResult(), 10, approximateTokenCount)).toThrow(/at least 64/);
    expect(() => capToolResultBody(oversizedResult(), 600.5, approximateTokenCount)).toThrow(/at least 64/);
  });

  function capRequest(input: unknown[], messages?: unknown[]): Record<string, unknown> {
    return {
      model: "gpt-5",
      instructions: "You are a support agent.",
      input,
      ...(messages === undefined ? {} : { messages }),
    };
  }

  it("caps oversized assistant bodies and reports a lossy, measured change record", () => {
    const { request: reduced, summary } = reduceRequest(
      capRequest([
        { role: "user", content: "Step 0." },
        { role: "assistant", content: oversizedResult() },
      ]),
      { freshToolResultCap: true },
    );
    const change = summary.changes.find((entry) => entry.lever === "fresh-tool-result-cap")!;
    expect(change.lossless).toBe(false);
    expect(change.estimatedTokensSaved).toBeGreaterThan(0);
    const wire = JSON.stringify(reduced);
    expect(wire).toContain("latest reference R-3-2");
    expect(wire).toContain("fresh tool-result detail capped");
  });

  it("returns the original request with NO change record when every body is under the threshold", () => {
    const original = capRequest([
      { role: "user", content: "Step 0." },
      { role: "assistant", content: "Done: latest reference R-1-1 recorded." },
    ]);
    const { request: reduced, summary } = reduceRequest(original, { freshToolResultCap: true });
    expect(reduced).toBe(original);
    expect(summary.changes).toHaveLength(0);
  });

  it("caps function_call_output, {text} parts and nested {content} shapes, in input and messages", () => {
    const { request: reduced } = reduceRequest(
      capRequest(
        [
          { role: "user", content: "Step 0." },
          { type: "function_call_output", call_id: "c1", output: oversizedResult(1, 1) },
          { role: "tool", content: [{ type: "output_text", text: oversizedResult(2, 1) }] },
          { role: "assistant", content: [{ content: oversizedResult(4, 1) }] },
        ],
        [{ role: "tool", content: oversizedResult(5, 1) }],
      ),
      { freshToolResultCap: true },
    );
    const next = reduced as Record<string, unknown>;
    const inputWire = JSON.stringify(next.input);
    const messagesWire = JSON.stringify(next.messages);
    expect(inputWire.match(/fresh tool-result detail capped/g)).toHaveLength(3);
    expect(messagesWire).toContain("fresh tool-result detail capped");
    for (const [task, wire] of [[1, inputWire], [2, inputWire], [4, inputWire], [5, messagesWire]] as const) {
      expect(wire).toContain(`latest reference R-${task}-1`);
    }
  });

  it("never touches user, system or developer messages, however oversized", () => {
    const body = oversizedResult(6, 1);
    const { request: reduced, summary } = reduceRequest(
      capRequest([
        { role: "system", content: body },
        { role: "developer", content: body },
        { role: "user", content: body },
      ]),
      { freshToolResultCap: true },
    );
    expect(summary.changes).toHaveLength(0);
    const wire = JSON.stringify(reduced);
    expect(wire.match(/fresh tool-result detail capped/g)).toBeNull();
    expect(wire).toContain("Record 17 shows a settlement entry");
  });

  it("skips the whole reduction, request untouched, on an invalid threshold", () => {
    const original = capRequest([{ role: "assistant", content: oversizedResult() }]);
    for (const maximumTokens of [10, 63, 600.5]) {
      const { request: reduced, summary } = reduceRequest(original, {
        freshToolResultCap: { maximumTokens },
      });
      expect(reduced).toBe(original);
      expect(summary.skipped).toBe(true);
      expect(summary.skippedReason).toMatch(/at least 64/);
    }
  });

  it("leaves capped bodies byte-identical through history compaction", () => {
    const input: unknown[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      input.push({ role: "user", content: `Step ${turn}.` });
      input.push({ role: "assistant", content: oversizedResult(7, turn) });
    }
    const capOnly = reduceRequest(capRequest([...input]), { freshToolResultCap: true });
    const both = reduceRequest(capRequest([...input]), {
      freshToolResultCap: true,
      historyCompaction: true,
    });
    expect(JSON.stringify((both.request as Record<string, unknown>).input))
      .toBe(JSON.stringify((capOnly.request as Record<string, unknown>).input));
    expect(both.summary.changes.some((entry) => entry.lever === "stale-history-compaction")).toBe(false);
  });
});

describe("withMesh reduction", () => {
  function stub(): { client: { responses: { create: (r: Record<string, unknown>) => Promise<unknown> } }; sent: Record<string, unknown>[] } {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      client: {
        responses: {
          create: async (payload: Record<string, unknown>) => {
            sent.push(payload);
            return { id: "r1", usage: { input_tokens: 100, output_tokens: 10 } };
          },
        },
      },
    };
  }

  it("reduces every request with no routing configured at all", async () => {
    // The point of the change: reduction used to fire only when a model swap
    // was selected, which made it unreachable for anyone not routing.
    const { client, sent } = stub();
    const wrapped = withMesh(client as never, {
      applicationId: "test",
      tokenReduction: { toolSchemas: true, repairCachePrefix: true },
    }) as unknown as { responses: { create: (r: unknown) => Promise<unknown> } };

    await wrapped.responses.create(request({
      instructions: "Current time: 2026-10-08T09:14:22Z\nYou are a support agent.",
    }));

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain("$schema");
    expect(String(sent[0]!.instructions).startsWith("You are a support agent.")).toBe(true);
  });

  it("sends the request untouched when reduction is not configured", async () => {
    const { client, sent } = stub();
    const wrapped = withMesh(client as never, { applicationId: "test" }) as unknown as
      { responses: { create: (r: unknown) => Promise<unknown> } };
    await wrapped.responses.create(request());
    expect(JSON.stringify(sent[0])).toContain("$schema");
  });

  it("reports what it removed on the request event", async () => {
    const { client } = stub();
    const events: Array<{ reduction?: MeshReductionSummary }> = [];
    const wrapped = withMesh(client as never, {
      applicationId: "test",
      tokenReduction: { toolSchemas: true },
      onEvent: (event) => events.push(event as { reduction?: MeshReductionSummary }),
    }) as unknown as { responses: { create: (r: unknown) => Promise<unknown> } };

    await wrapped.responses.create(request());
    expect(events).toHaveLength(1);
    expect(events[0]!.reduction?.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("still returns the provider's response unchanged", async () => {
    const { client } = stub();
    const wrapped = withMesh(client as never, {
      applicationId: "test",
      tokenReduction: { toolSchemas: true },
    }) as unknown as { responses: { create: (r: unknown) => Promise<{ id: string }> } };
    const response = await wrapped.responses.create(request());
    expect(response.id).toBe("r1");
  });
});

describe("cacheTtl 1h stamping", () => {
  // Repeated past Anthropic's 1,024-token cacheable minimum (see
  // `anthropicCacheableMinimumTokens`): these fixtures are for exercising
  // BREAKPOINT PLACEMENT, not the separate below-minimum guard, which has its
  // own dedicated tests further down this file.
  const STABLE_SYSTEM = "You are a support agent. Follow the escalation policy exactly. ".repeat(90);

  const anthropicRequest = (content: unknown = "Summarise the account history."): Record<string, unknown> => ({
    model: "claude-sonnet-4-5",
    system: STABLE_SYSTEM,
    messages: [
      { role: "user", content: "Earlier turn." },
      { role: "user", content },
    ],
  });

  it("stamps the system prompt (lifted into a block) and, on multi-turn, the last message", () => {
    const { request: reduced, summary } = reduceRequest(anthropicRequest(), { cacheTtl: "1h" });
    const system = (reduced as Record<string, unknown>).system as Array<Record<string, unknown>>;
    expect(system).toEqual([
      { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    const messages = (reduced as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const blocks = messages[messages.length - 1]!.content as Array<Record<string, unknown>>;
    expect(blocks[blocks.length - 1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[blocks.length - 1]!.text).toBe("Summarise the account history.");
    expect(summary.changes.map((change) => change.lever)).toContain("cache-ttl-1h");
    // A rate change, not a prompt change: nothing was removed.
    expect(summary.changes.find((change) => change.lever === "cache-ttl-1h")!.estimatedTokensSaved).toBe(0);
  });

  it("stamps an existing block array without disturbing the other blocks", () => {
    const { request: reduced } = reduceRequest(
      anthropicRequest([{ type: "text", text: "First." }, { type: "text", text: "Second." }]),
      { cacheTtl: "1h" },
    );
    const messages = (reduced as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const blocks = messages[messages.length - 1]!.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "First." });
    expect(blocks[1]).toEqual({ type: "text", text: "Second.", cache_control: { type: "ephemeral", ttl: "1h" } });
  });

  it("never stamps a one-shot request with no system prompt: its prefix never repeats", () => {
    // The first live export measured this exact shape losing money under the
    // old last-message placement: 8 writes at the 2x premium, 0 reads.
    const request = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Classify this ticket." }],
    };
    const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "1h" });
    expect(reduced).toBe(request);
    expect(summary.changes).toHaveLength(0);
  });

  it("stamps ONLY the system prompt on a one-shot request that has one", () => {
    const request = {
      model: "claude-sonnet-4-5",
      system: STABLE_SYSTEM,
      messages: [{ role: "user", content: "Classify this ticket." }],
    };
    const { request: reduced } = reduceRequest(request, { cacheTtl: "1h" });
    const system = (reduced as Record<string, unknown>).system as Array<Record<string, unknown>>;
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The varying message carries no breakpoint, so it never bills a write premium.
    expect(JSON.stringify((reduced as Record<string, unknown>).messages)).not.toContain("cache_control");
  });

  it("stamps ttl '5m' with its own lever id for multi-turn agents", () => {
    const { request: reduced, summary } = reduceRequest(anthropicRequest(), { cacheTtl: "5m" });
    const system = (reduced as Record<string, unknown>).system as Array<Record<string, unknown>>;
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(summary.changes.map((change) => change.lever)).toContain("cache-ttl-5m");
    expect(summary.changes.some((change) => change.lever === "cache-ttl-1h")).toBe(false);
  });

  it("leaves non-Anthropic requests untouched", () => {
    const request = { model: "gpt-5", messages: [{ role: "user", content: "Hello." }] };
    const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "1h" });
    expect(reduced).toBe(request);
    expect(summary.changes).toHaveLength(0);
  });

  it("defers to a caller who already placed their own cache_control", () => {
    const request = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "Pinned.", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "Next question." },
      ],
    };
    const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "1h" });
    expect(reduced).toBe(request);
    expect(summary.changes).toHaveLength(0);
  });

  it("does not mutate the caller's original messages", () => {
    const original = anthropicRequest();
    const snapshot = JSON.stringify(original);
    reduceRequest(original, { cacheTtl: "1h" });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  describe("below Anthropic's per-model cacheable minimum", () => {
    // Anthropic will not cache a prefix shorter than its documented minimum
    // at all (1,024 tokens; 2,048 on Haiku-class models) — it just processes
    // the request without caching, a silent provider-side no-op. Stamping a
    // breakpoint there would buy a write premium and never read, and would
    // record a saving that can never happen.

    it("withholds the stamp on a one-shot request whose system prompt is short, and records why", () => {
      const request = {
        model: "claude-sonnet-4-5",
        system: "You are a classifier.",
        messages: [{ role: "user", content: "Classify this ticket." }],
      };
      const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "1h" });
      // Nothing was changed at all: this is a pure no-op, not a stamp-then-strip.
      expect(reduced).toEqual(request);
      expect(JSON.stringify(reduced)).not.toContain("cache_control");
      const suppression = summary.changes.find((change) => change.lever === "cache-ttl-suppressed");
      expect(suppression).toBeDefined();
      expect(suppression!.detail).toContain("cacheable minimum");
      expect(suppression!.detail).toContain("1024");
      expect(suppression!.detail).toContain("1332");
      expect(summary.changes.some((change) => change.lever === "cache-ttl-1h")).toBe(false);
    });

    it("stamps a prefix on Sonnet but withholds the identical prefix on Haiku, which needs twice as many tokens", () => {
      // STABLE_SYSTEM clears Anthropic's 1,024-token Sonnet/Opus minimum but
      // sits below its 2,048-token Haiku minimum - the model, not just the
      // prefix size, decides whether this stamp earns anything.
      const sonnetRequest = { model: "claude-sonnet-4-5", system: STABLE_SYSTEM, messages: [{ role: "user", content: "Classify this ticket." }] };
      const haikuRequest = { model: "claude-haiku-5-5", system: STABLE_SYSTEM, messages: [{ role: "user", content: "Classify this ticket." }] };

      const sonnet = reduceRequest(sonnetRequest, { cacheTtl: "1h" });
      expect(JSON.stringify(sonnet.request)).toContain("cache_control");
      expect(sonnet.summary.changes.some((change) => change.lever === "cache-ttl-1h")).toBe(true);

      const haiku = reduceRequest(haikuRequest, { cacheTtl: "1h" });
      expect(haiku.request).toEqual(haikuRequest);
      expect(JSON.stringify(haiku.request)).not.toContain("cache_control");
      const suppression = haiku.summary.changes.find((change) => change.lever === "cache-ttl-suppressed");
      expect(suppression).toBeDefined();
      expect(suppression!.detail).toContain("2048");
      expect(suppression!.detail).toContain("2663");
    });

    it("withholds the message breakpoint on a short multi-turn conversation with no system prompt", () => {
      // No system at all, so only the message breakpoint is a candidate; its
      // prefix is the whole running conversation, still well under 1,024
      // tokens here, so it must be measured and suppressed the same way.
      const request = {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: "Step 0: continue." },
          { role: "assistant", content: "Done with step 0." },
          { role: "user", content: "Step 1: continue." },
        ],
      };
      const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "5m" });
      expect(reduced).toEqual(request);
      expect(JSON.stringify(reduced)).not.toContain("cache_control");
      const suppression = summary.changes.find((change) => change.lever === "cache-ttl-suppressed");
      expect(suppression).toBeDefined();
      expect(suppression!.detail).toContain("cacheable minimum");
    });

    it("still stamps the message breakpoint once the running conversation itself clears the minimum", () => {
      // Same shape as the previous test, but the history has grown past the
      // minimum on its own (no system prompt contributes anything): the
      // guard must look at the FULL prefix, not assume a short system means
      // a short request.
      const request = {
        model: "claude-sonnet-4-5",
        messages: [
          { role: "user", content: STABLE_SYSTEM },
          { role: "assistant", content: "Acknowledged." },
          { role: "user", content: "Step 1: continue." },
        ],
      };
      const { request: reduced, summary } = reduceRequest(request, { cacheTtl: "5m" });
      expect(JSON.stringify(reduced)).toContain("cache_control");
      expect(summary.changes.some((change) => change.lever === "cache-ttl-5m")).toBe(true);
    });
  });
});

describe("output effort governor", () => {
  const anthropicRequest = (model = "claude-sonnet-5") => ({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: "Summarise the incident." }],
  });

  it("sets output_config.effort on a supported Claude model and reports it lossy", () => {
    const { request: reduced, summary } = reduceRequest(anthropicRequest(), { outputEffort: "low" });
    expect((reduced as Record<string, unknown>).output_config).toEqual({ effort: "low" });
    const change = summary.changes.find((c) => c.lever === "output-effort-low");
    expect(change?.lossless).toBe(false);
    expect(change?.estimatedTokensSaved).toBe(0);
  });

  it("is off by default", () => {
    const { request: reduced } = reduceRequest(anthropicRequest(), {});
    expect((reduced as Record<string, unknown>).output_config).toBeUndefined();
  });

  it("respects a caller who set their own effort and records no change", () => {
    const req = { ...anthropicRequest(), output_config: { effort: "max" } };
    const { request: reduced, summary } = reduceRequest(req, { outputEffort: "low" });
    expect((reduced as Record<string, unknown>).output_config).toEqual({ effort: "max" });
    expect(summary.changes.some((c) => c.lever.startsWith("output-effort"))).toBe(false);
  });

  it("merges into an existing output_config without effort, preserving other keys", () => {
    const req = { ...anthropicRequest(), output_config: { format: { type: "json" } } };
    const { request: reduced } = reduceRequest(req, { outputEffort: "medium" });
    expect((reduced as Record<string, unknown>).output_config).toEqual({
      format: { type: "json" },
      effort: "medium",
    });
  });

  it("suppresses rather than stamping an unsupported level on an older model", () => {
    const { request: reduced, summary } =
      reduceRequest(anthropicRequest("claude-opus-4-6"), { outputEffort: "xhigh" });
    expect((reduced as Record<string, unknown>).output_config).toBeUndefined();
    expect(summary.changes.some((c) => c.lever === "output-effort-suppressed")).toBe(true);
  });

  it("suppresses on a model with no effort support at all (Haiku)", () => {
    const { request: reduced, summary } =
      reduceRequest(anthropicRequest("claude-haiku-4-5"), { outputEffort: "low" });
    expect((reduced as Record<string, unknown>).output_config).toBeUndefined();
    expect(summary.changes.some((c) => c.lever === "output-effort-suppressed")).toBe(true);
  });

  it("never stamps a non-Claude request (OpenAI reasoning.effort is a different field)", () => {
    const req = { model: "gpt-5", messages: [{ role: "user", content: "Hi" }] };
    const { request: reduced, summary } = reduceRequest(req, { outputEffort: "low" });
    expect((reduced as Record<string, unknown>).output_config).toBeUndefined();
    expect(summary.changes.some((c) => c.lever.startsWith("output-effort"))).toBe(false);
  });

  it("is byte-stable: a stamped request re-reduces to the same bytes", () => {
    const first = reduceRequest(anthropicRequest("claude-opus-5"), { outputEffort: "low" });
    const second = reduceRequest(first.request, { outputEffort: "low" });
    expect(JSON.stringify(second.request)).toBe(JSON.stringify(first.request));
  });

  it("does not stamp effort on a claude request with no messages array", () => {
    const { request: reduced } = reduceRequest({ model: "claude-sonnet-5" }, { outputEffort: "low" });
    expect((reduced as Record<string, unknown>).output_config).toBeUndefined();
  });
});

describe("reduceRequest — unused-tool removal (dropTools)", () => {
  // Anthropic-shaped catalogue: tools are {name, description, input_schema}.
  const anthropicTools = (): unknown[] => [
    { name: "search_docs", description: LONG_DESCRIPTION, input_schema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "delete_record", description: LONG_DESCRIPTION, input_schema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "send_email", description: LONG_DESCRIPTION, input_schema: { type: "object", properties: { to: { type: "string" } } } },
  ];
  const anthropicRequest = (): Record<string, unknown> => ({
    model: "claude-sonnet-5-5",
    system: "You are a support agent.",
    tools: anthropicTools(),
    messages: [{ role: "user", content: "Look up the refund policy." }],
  });

  it("removes named tools (Anthropic shape) and reports it as a lossy change with real savings", () => {
    const { request: reduced, summary } = reduceRequest(anthropicRequest(), { dropTools: ["delete_record", "send_email"] });
    const names = ((reduced as Record<string, unknown>).tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(["search_docs"]); // the two unused tools are gone
    const change = summary.changes.find((c) => c.lever === "unused-tool-removal")!;
    expect(change.lossless).toBe(false);
    expect(change.estimatedTokensSaved).toBeGreaterThan(0);
    expect(summary.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("removes named tools (OpenAI {type:function} shape)", () => {
    // toolCatalogue() names are lookup_0, lookup_1.
    const { request: reduced } = reduceRequest(request({ tools: toolCatalogue(3) }), { dropTools: ["lookup_1"] });
    const names = ((reduced as Record<string, unknown>).tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toEqual(["lookup_0", "lookup_2"]);
  });

  it("is a no-op for an empty list, and for names not in the catalogue", () => {
    const empty = reduceRequest(anthropicRequest(), { dropTools: [] });
    expect(empty.summary.changes.some((c) => c.lever === "unused-tool-removal")).toBe(false);
    const unknown = reduceRequest(anthropicRequest(), { dropTools: ["no_such_tool"] });
    expect((unknown.request as Record<string, unknown>).tools).toHaveLength(3); // nothing removed
    expect(unknown.summary.changes.some((c) => c.lever === "unused-tool-removal")).toBe(false);
  });

  it("is idempotent: re-reducing a trimmed request removes nothing more", () => {
    const first = reduceRequest(anthropicRequest(), { dropTools: ["delete_record"] });
    const second = reduceRequest(first.request, { dropTools: ["delete_record"] });
    expect(JSON.stringify(second.request)).toBe(JSON.stringify(first.request));
    expect(second.summary.changes.some((c) => c.lever === "unused-tool-removal")).toBe(false);
  });

  it("composes with schema minification: drop first, then compact the survivors", () => {
    const { request: reduced, summary } = reduceRequest(
      request({ tools: toolCatalogue(3) }),
      { dropTools: ["lookup_2"], toolSchemas: true },
    );
    const tools = (reduced as Record<string, unknown>).tools as unknown[];
    expect(tools).toHaveLength(2); // one dropped
    expect(JSON.stringify(reduced)).not.toContain("$schema"); // survivors minified
    expect(summary.changes.some((c) => c.lever === "unused-tool-removal")).toBe(true);
    expect(summary.changes.some((c) => c.lever === "tool-schema-compaction")).toBe(true);
  });
});
