import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationPolicyPins, UNTOUCHED_POLICY } from "./conversation-policy-pins.js";
import { reduceRequest, type MeshTokenReductionConfig } from "./reduce-request.js";

/**
 * A conversation keeps the policy it started with, so a policy that changes
 * while it is in flight cannot re-write the prefix its provider is caching.
 */

type Message = Record<string, unknown>;
type Request = Record<string, unknown>;

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-24T09:00:00.000Z");
const TOOLS = [{
  name: "search",
  description: "Search the corpus and return the most relevant passages for the query.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "SearchInput",
    type: "object",
    properties: { q: { type: "string", title: "q" } },
    required: ["q"],
  },
}];

/** Turn `turn` (1-based) of a conversation that opens with `opening`. */
function turnOf(opening: string, turn: number, extra: Request = {}): Request {
  const messages: Message[] = [{ role: "user", content: opening }];
  for (let done = 1; done < turn; done += 1) {
    messages.push({ role: "assistant", content: `Answer ${done}.` });
    messages.push({ role: "user", content: `Follow-up ${done}.` });
  }
  return { model: "claude-sonnet-5-5", max_tokens: 100, system: "You are terse.", tools: TOOLS, messages, ...extra };
}
const MARK = { cache_control: { type: "ephemeral" } };
const callerCached = (request: Request): Request => ({ ...request, system: [{ type: "text", text: "You are terse.", ...MARK }] });

const OFF: MeshTokenReductionConfig = { toolSchemas: false, duplicateContext: false };
const SCHEMAS: MeshTokenReductionConfig = { toolSchemas: true, duplicateContext: false };

describe("ConversationPolicyPins", () => {
  it("a conversation in flight keeps the policy it started with; a new one takes the current policy", () => {
    const pins = new ConversationPolicyPins();
    expect(pins.resolve(turnOf("Find the clause.", 1), OFF, T0).decision).toBe("started");

    // The policy changes while the conversation is in flight.
    const second = pins.resolve(turnOf("Find the clause.", 2), SCHEMAS, T0 + 20_000);
    expect(second.decision).toBe("kept");
    expect(second.config.toolSchemas).toBe(false);
    const third = pins.resolve(turnOf("Find the clause.", 3), SCHEMAS, T0 + 40_000);
    expect(third.config.toolSchemas).toBe(false);

    // The bytes the provider would cache are the same before and after the change.
    const before = reduceRequest(turnOf("Find the clause.", 2), OFF).request as Request;
    const after = reduceRequest(turnOf("Find the clause.", 2), second.config).request as Request;
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));

    const other = pins.resolve(turnOf("A different question.", 1), SCHEMAS, T0 + 50_000);
    expect(other.decision).toBe("started");
    expect(other.config.toolSchemas).toBe(true);
    expect(pins.size).toBe(2);
  });

  it("a request that starts a conversation always takes the current policy, so one-shot calls are never held back", () => {
    const pins = new ConversationPolicyPins();
    expect(pins.resolve(turnOf("Classify this.", 1), OFF, T0).config.toolSchemas).toBe(false);
    // The same opening message again, after the policy changed: a new start.
    const again = pins.resolve(turnOf("Classify this.", 1), SCHEMAS, T0 + 5_000);
    expect(again.decision).toBe("started");
    expect(again.config.toolSchemas).toBe(true);
    expect(pins.size).toBe(1);

    // A few-shot one-shot call: it carries assistant turns but never grows.
    const fewShot = turnOf("Example question.", 3);
    expect(pins.resolve(fewShot, OFF, T0).decision).toBe("started");
    const next = pins.resolve(fewShot, SCHEMAS, T0 + 5_000);
    expect(next.decision).toBe("started");
    expect(next.config.toolSchemas).toBe(true);
  });

  it("once idle longer than any cache lives, a conversation takes the current policy", () => {
    const pins = new ConversationPolicyPins();
    pins.resolve(turnOf("Find the clause.", 1), OFF, T0);
    expect(pins.resolve(turnOf("Find the clause.", 2), SCHEMAS, T0 + HOUR - 1).decision).toBe("kept");
    // Each request keeps the provider's cache alive, so the clock runs from the last one.
    expect(pins.resolve(turnOf("Find the clause.", 3), SCHEMAS, T0 + 2 * HOUR - 2).decision).toBe("kept");
    const late = pins.resolve(turnOf("Find the clause.", 4), SCHEMAS, T0 + 3 * HOUR + 1);
    expect(late.decision).toBe("refreshed");
    expect(late.config.toolSchemas).toBe(true);
    expect(pins.resolve(turnOf("Find the clause.", 5), OFF, T0 + 3 * HOUR + 20_000).config.toolSchemas).toBe(true);
  });

  it("a lossy lever the current policy withdrew is dropped at once; the rest of the pin stays", () => {
    const pins = new ConversationPolicyPins();
    const withLossy: MeshTokenReductionConfig = {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 8 },
      duplicateContext: true,
      toolResultJson: true,
      freshToolResultCap: { maximumTokens: 600 },
      outputEffort: "low",
    };
    pins.resolve(turnOf("Find the clause.", 1), withLossy, T0);

    // Theo rolls the cap and the trim back for quality drift; JSON compaction is also switched off.
    const rolledBack: MeshTokenReductionConfig = { toolSchemas: true, duplicateContext: true, outputEffort: "low" };
    const next = pins.resolve(turnOf("Find the clause.", 2), rolledBack, T0 + 20_000);
    expect(next.decision).toBe("kept-lossy-withdrawn");
    expect(next.config.freshToolResultCap).toBeUndefined();
    expect(next.config.toolSchemas).toBe(true); // down to the lossless tier
    expect(next.config.outputEffort).toBe("low"); // still in the current policy
    expect(next.config.toolResultJson).toBe(true); // lossless: stays until the conversation ends

    // It stays dropped, and is not reported again.
    const later = pins.resolve(turnOf("Find the clause.", 3), rolledBack, T0 + 40_000);
    expect(later.decision).toBe("kept");
    expect(later.config.freshToolResultCap).toBeUndefined();

    // With schemas off altogether in the current policy, a withdrawn trim goes to off, not to compaction.
    const pinsB = new ConversationPolicyPins();
    pinsB.resolve(turnOf("Another.", 1), withLossy, T0);
    expect(pinsB.resolve(turnOf("Another.", 2), { toolSchemas: false }, T0 + 1).config.toolSchemas).toBe(false);
  });

  it("a lossy lever ADDED to the policy does not reach a conversation in flight", () => {
    const pins = new ConversationPolicyPins();
    pins.resolve(turnOf("Find the clause.", 1), SCHEMAS, T0);
    const next = pins.resolve(turnOf("Find the clause.", 2), { ...SCHEMAS, freshToolResultCap: true, historyCompaction: true }, T0 + 1);
    expect(next.decision).toBe("kept");
    expect(next.config.freshToolResultCap).toBeUndefined();
    expect(next.config.historyCompaction).toBeUndefined();
  });

  it("a conversation joined mid-flight under the caller's cache is left untouched", () => {
    const pins = new ConversationPolicyPins();
    const policy: MeshTokenReductionConfig = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, toolResultJson: true };
    const joined = callerCached(turnOf("Long-running session.", 4));
    const first = pins.resolve(joined, policy, T0);
    expect(first.decision).toBe("untouched");
    // Nothing at all is changed: the reducer hands back the caller's own object.
    expect(reduceRequest(joined, first.config).request).toBe(joined);
    expect(reduceRequest(joined, policy).request).not.toBe(joined); // the policy WOULD have changed it

    const next = callerCached(turnOf("Long-running session.", 5));
    expect(pins.resolve(next, policy, T0 + 20_000).decision).toBe("untouched");
    // A retry of the turn it was joined at is still untouched.
    expect(pins.resolve(joined, policy, T0 + 30_000).decision).toBe("untouched");

    // One cache lifetime after it was first seen it joins the current policy.
    const late = pins.resolve(callerCached(turnOf("Long-running session.", 6)), policy, T0 + HOUR + 1);
    expect(late.decision).toBe("refreshed");
    expect(late.config.toolSchemas).toBe(true);

    // A strictly shorter request with the same opening is a new conversation.
    const pinsB = new ConversationPolicyPins();
    pinsB.resolve(joined, policy, T0);
    expect(pinsB.resolve(callerCached(turnOf("Long-running session.", 1)), policy, T0 + 1).decision).toBe("started");
  });

  it("a caching client that moves its marker every turn is still one conversation", () => {
    // Turn 1: the marker sits on the first (and newest) message. Turn 2: it has
    // moved to the newest message and the first one is a plain string again.
    const marked = (turn: number): Request => {
      const request = turnOf("Find the clause.", turn);
      const messages = request.messages as Message[];
      const last = messages[messages.length - 1]!;
      return {
        ...request,
        messages: [...messages.slice(0, -1), { ...last, content: [{ type: "text", text: last.content, ...MARK }] }],
      };
    };
    const pins = new ConversationPolicyPins();
    expect(pins.resolve(marked(1), SCHEMAS, T0).decision).toBe("started");
    const second = pins.resolve(marked(2), OFF, T0 + 20_000);
    expect(second.decision).toBe("kept");
    expect(second.config.toolSchemas).toBe(true);
    expect(pins.resolve(marked(3), OFF, T0 + 40_000).decision).toBe("kept");
    expect(pins.size).toBe(1);
  });

  it("joined mid-flight with no caller cache, there is nothing to protect: the current policy applies", () => {
    const pins = new ConversationPolicyPins();
    const first = pins.resolve(turnOf("Uncached session.", 4), SCHEMAS, T0);
    expect(first.decision).toBe("started");
    expect(first.config.toolSchemas).toBe(true);
    // From here on it is pinned like any other.
    expect(pins.resolve(turnOf("Uncached session.", 5), OFF, T0 + 1).config.toolSchemas).toBe(true);
  });

  it("keeps the stamp's lifetime for the conversation and carries the current policy's callbacks", () => {
    const pins = new ConversationPolicyPins();
    const guard = { observe: () => ({ stamp: true }) };
    const countTokens = (text: string): number => text.length;
    pins.resolve(turnOf("Find the clause.", 1), { cacheTtl: "5m" }, T0);
    const next = pins.resolve(turnOf("Find the clause.", 2), { cacheTtl: "1h", cacheVolatilityGuard: guard, countTokens }, T0 + 1);
    expect(next.config.cacheTtl).toBe("5m");
    expect(next.config.cacheVolatilityGuard).toBe(guard);
    expect(next.config.countTokens).toBe(countTokens);
    // Switching the stamp off does not take a live cache away from the conversation.
    expect(pins.resolve(turnOf("Find the clause.", 3), {}, T0 + 2).config.cacheTtl).toBe("5m");
  });

  it("leaves requests it cannot place alone, and never mutates the policy it is given", () => {
    const pins = new ConversationPolicyPins();
    for (const request of [null, "text", 7, {}, { model: "x", messages: [] }, { model: "x", input: "a string" }]) {
      const resolved = pins.resolve(request, SCHEMAS, T0);
      expect(resolved.decision).toBe("unpinned");
      expect(resolved.config).toBe(SCHEMAS);
    }
    expect(pins.size).toBe(0);

    const current: MeshTokenReductionConfig = { toolSchemas: { descriptions: "truncate" }, dropTools: ["a"] };
    const snapshot = JSON.stringify(current);
    const first = pins.resolve(turnOf("Find the clause.", 1), current, T0);
    (first.config.dropTools as string[]).push("b");
    expect(JSON.stringify(current)).toBe(snapshot);
    expect(pins.resolve(turnOf("Find the clause.", 2), current, T0 + 1).config.dropTools).toEqual(["a"]);
  });

  it("works on Responses-shaped requests", () => {
    const pins = new ConversationPolicyPins();
    const start = { model: "gpt-5", input: [{ role: "user", content: "Look this up." }] };
    const later = { model: "gpt-5", input: [...start.input, { type: "function_call", call_id: "c1", name: "search", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "{}" }] };
    expect(pins.resolve(start, OFF, T0).decision).toBe("started");
    expect(pins.resolve(later, SCHEMAS, T0 + 1).decision).toBe("kept");
  });

  it("remembers a bounded number of conversations, dropping the least recently seen", () => {
    const pins = new ConversationPolicyPins({ maxConversations: 3 });
    for (const name of ["a", "b", "c"]) pins.resolve(turnOf(name, 1), OFF, T0);
    pins.resolve(turnOf("a", 2), SCHEMAS, T0 + 1); // "a" is now the most recent
    pins.resolve(turnOf("d", 1), OFF, T0 + 2); // pushes "b" out
    expect(pins.size).toBe(3);
    expect(pins.resolve(turnOf("a", 3), SCHEMAS, T0 + 3).decision).toBe("kept");
    // "b" was forgotten: its next turn is treated as a conversation first seen now.
    expect(pins.resolve(turnOf("b", 2), SCHEMAS, T0 + 4).decision).toBe("started");
    expect(() => new ConversationPolicyPins({ maxConversations: 0 })).toThrow();
  });

  it("with a key and a path the pins survive a restart, and the file holds no content", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mesh-pins-")), "nested", "conversation-pins.json");
    const options = { hmacKey: "test-deployment-key", persistPath: path };
    const before = new ConversationPolicyPins(options);
    before.resolve(turnOf("A very recognisable opening sentence.", 1), OFF, T0);
    before.resolve(callerCached(turnOf("Joined later.", 3)), SCHEMAS, T0 + 100);
    before.flush(T0 + 200);

    const stored = readFileSync(path, "utf8");
    expect(stored).not.toContain("recognisable");
    expect(stored).not.toContain("Joined later");
    expect(JSON.parse(stored)).toMatchObject({ version: 1 });

    // A new process, a new policy: the conversations in flight keep what they had.
    const after = new ConversationPolicyPins(options);
    expect(after.size).toBe(2);
    const kept = after.resolve(turnOf("A very recognisable opening sentence.", 2), SCHEMAS, T0 + 20_000);
    expect(kept.decision).toBe("kept");
    expect(kept.config.toolSchemas).toBe(false);
    expect(after.resolve(callerCached(turnOf("Joined later.", 4)), SCHEMAS, T0 + 20_000).decision).toBe("untouched");

    // A different key cannot match the stored conversations.
    const otherKey = new ConversationPolicyPins({ hmacKey: "another-key", persistPath: path });
    expect(otherKey.resolve(turnOf("A very recognisable opening sentence.", 2), SCHEMAS, T0 + 20_000).decision).toBe("started");
  });

  it("writes nothing without a key, and an unreadable pin file is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-pins-"));
    const noKey = new ConversationPolicyPins({ persistPath: join(dir, "pins.json") });
    noKey.resolve(turnOf("Find the clause.", 1), OFF, T0);
    noKey.flush(T0 + 1);
    expect(existsSync(join(dir, "pins.json"))).toBe(false);

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    const pins = new ConversationPolicyPins({ hmacKey: "k", persistPath: broken });
    expect(pins.size).toBe(0);
    expect(pins.resolve(turnOf("Find the clause.", 1), OFF, T0).decision).toBe("started");

    writeFileSync(broken, JSON.stringify({ version: 1, pins: [["k1", { policy: "nope" }], "junk", ["k2", { policy: {}, firstSeenMs: 1, lastSeenMs: 2 }]] }));
    expect(new ConversationPolicyPins({ hmacKey: "k", persistPath: broken }).size).toBe(1);
  });

  it("the untouched policy really changes nothing", () => {
    const request = { ...turnOf("Find the clause.", 3), system: `Current time: 2026-11-24T09:00:00Z\nYou are terse.\n\nYou are terse.` };
    expect(reduceRequest(request, UNTOUCHED_POLICY).request).toBe(request);
  });
});
