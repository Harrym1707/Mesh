import { describe, expect, it } from "vitest";
import { CachePrefixVolatilityGuard } from "./cache-volatility-guard.js";
import { reduceRequest } from "./reduce-request.js";

// Repeated past 1.30x Anthropic's 1,024-token cacheable minimum (the
// approximate counter's calibrated overcount margin; see
// `anthropicCacheableMinimumTokens`), so these fixtures exercise placement
// and volatility, not the separate below-minimum guard covered in
// reduce-request.test.ts.
const PREAMBLE = "You are a careful coding agent. Cite sources, run the tests, escalate anything risky. ".repeat(65);

/** A multi-turn agent request; `clock` injects per-turn churn into system. */
function turn(turnIndex: number, clock?: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (let index = 0; index <= turnIndex; index += 1) {
    messages.push({ role: "user", content: `Step ${index}: continue the refactor.` });
    if (index < turnIndex) messages.push({ role: "assistant", content: `Done with step ${index}.` });
  }
  return {
    model: "claude-sonnet-5-5",
    max_tokens: 400,
    system: clock === undefined ? PREAMBLE : `Current time: ${clock}\n${PREAMBLE}`,
    messages,
  };
}

describe("CachePrefixVolatilityGuard", () => {
  it("stamps a conversation whose prefix is stable across turns", () => {
    const guard = new CachePrefixVolatilityGuard();
    for (let index = 0; index < 5; index += 1) {
      expect(guard.observe(turn(index)).stamp).toBe(true);
    }
  });

  it("suppresses from the first turn that reveals a churning system, and stays suppressed while it churns", () => {
    const guard = new CachePrefixVolatilityGuard();
    expect(guard.observe(turn(0, "09:00:00Z")).stamp).toBe(true); // nothing known yet
    for (let index = 1; index < 6; index += 1) {
      const decision = guard.observe(turn(index, `09:0${index}:00Z`));
      expect(decision.stamp).toBe(false);
      expect(decision.reason).toContain("tools/system changed");
    }
  });

  it("resumes stamping after two consecutive stable turns (a one-off disturbance is forgiven)", () => {
    const guard = new CachePrefixVolatilityGuard();
    expect(guard.observe(turn(0, "09:00:00Z")).stamp).toBe(true);
    expect(guard.observe(turn(1, "09:05:00Z")).stamp).toBe(false); // churn revealed
    expect(guard.observe(turn(2, "09:05:00Z")).stamp).toBe(false); // first stable turn: still proving
    expect(guard.observe(turn(3, "09:05:00Z")).stamp).toBe(true);  // second stable turn: resumed
    expect(guard.observe(turn(4, "09:05:00Z")).stamp).toBe(true);
  });

  it("withholds only the message breakpoint when the history is rewritten instead of extended", () => {
    const guard = new CachePrefixVolatilityGuard();
    expect(guard.observe(turn(2)).stamp).toBe(true);
    const rewritten = turn(2) as { messages: Array<Record<string, unknown>> };
    rewritten.messages[1] = { role: "assistant", content: "[summarised by the client framework]" };
    const decision = guard.observe(rewritten);
    // The tools + system breakpoint sits BEFORE the history, so a rewritten
    // history cannot stop it reading; only the newest-message breakpoint is lost.
    expect(decision.stamp).toBe(true);
    expect(decision.messageBreakpoint).toBe(false);
    expect(decision.reason).toContain("history was rewritten");
  });

  it("restores the message breakpoint after two consecutive extending turns", () => {
    const guard = new CachePrefixVolatilityGuard();
    guard.observe(turn(2));
    const rewritten = turn(2) as { messages: Array<Record<string, unknown>> };
    rewritten.messages[1] = { role: "assistant", content: "[summarised by the client framework]" };
    expect(guard.observe(rewritten).messageBreakpoint).toBe(false);
    const grow = (extra: number): Record<string, unknown> => ({
      ...rewritten,
      messages: [
        ...rewritten.messages,
        ...Array.from({ length: extra }, (_, index) => ({ role: index % 2 === 0 ? "assistant" : "user", content: `more ${index}` })),
      ],
    });
    expect(guard.observe(grow(2)).messageBreakpoint).toBe(false); // first extending turn: still proving
    expect(guard.observe(grow(4))).toEqual({ stamp: true });      // second: fully restored
  });

  it("compares the stamped span when the reducer supplies it, not the raw system", () => {
    const guard = new CachePrefixVolatilityGuard();
    // The raw system ticks every turn, but the content the breakpoint covers
    // (what the provider matches on) is identical: that is not churn.
    for (let index = 0; index < 5; index += 1) {
      const decision = guard.observe(turn(index, `09:0${index}:00Z`), { stampedPrefix: ["m", null, [{ type: "text", text: PREAMBLE }]] });
      expect(decision.stamp).toBe(true);
    }
    // And a span that does change is still caught.
    const changed = guard.observe(turn(5, "09:05:00Z"), { stampedPrefix: ["m", null, [{ type: "text", text: `${PREAMBLE} v2` }]] });
    expect(changed.stamp).toBe(false);
    expect(changed.reason).toContain("tools/system changed");
  });

  it("keeps conversations independent: churn in one never suppresses another", () => {
    const guard = new CachePrefixVolatilityGuard();
    const other = { model: "claude-sonnet-5-5", system: PREAMBLE, messages: [{ role: "user", content: "unrelated" }] };
    guard.observe(turn(0, "09:00:00Z"));
    guard.observe(turn(1, "09:05:00Z")); // conversation A churns
    expect(guard.observe(other).stamp).toBe(true);
  });

  it("stamps one-shot templated traffic (distinct conversations sharing a stable system)", () => {
    const guard = new CachePrefixVolatilityGuard();
    for (let index = 0; index < 4; index += 1) {
      const request = {
        model: "claude-sonnet-5-5",
        system: PREAMBLE,
        messages: [{ role: "user", content: `Ticket ${index}: classify this.` }],
      };
      expect(guard.observe(request).stamp).toBe(true);
    }
  });

  it("evicts the least recently seen conversation at the cap", () => {
    const guard = new CachePrefixVolatilityGuard(2);
    guard.observe(turn(0, "09:00:00Z"));
    guard.observe(turn(1, "09:05:00Z")); // conversation A is now volatile
    guard.observe({ model: "m", system: "s", messages: [{ role: "user", content: "b" }] });
    guard.observe({ model: "m", system: "s", messages: [{ role: "user", content: "c" }] }); // evicts A
    // A returns: its volatility record is gone, so it is treated as new.
    expect(guard.observe(turn(2, "09:10:00Z")).stamp).toBe(true);
  });
});

describe("reduceRequest with the guard and the volatile-tail placement", () => {
  const config = {
    repairCachePrefix: true,
    cacheTtl: "5m",
  } as const;

  it("splits a repaired system so the breakpoint covers only the stable text, and skips the message breakpoint", () => {
    const request = turn(3, "2026-10-20T09:03:00Z");
    const { request: reduced, summary } = reduceRequest(request, { ...config });
    expect(summary.skipped).toBe(false);
    const system = (reduced as { system: Array<{ text: string; cache_control?: unknown }> }).system;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(2);
    // The stable preamble carries the breakpoint; the relocated clock does not.
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(system[0]!.text).not.toContain("Current time");
    expect(system[1]!.cache_control).toBeUndefined();
    expect(system[1]!.text).toContain("Current time: 2026-10-20T09:03:00Z");
    // Reordered, never removed: concatenating the blocks with NO inserted
    // separator (how the provider reads adjacent text blocks) must reproduce
    // the repaired text exactly, byte for byte (repair itself reorders the
    // clock line to the end, so the reference is the repaired text, not the
    // pre-repair request).
    expect(`${system[0]!.text}${system[1]!.text}`).toEqual(`${PREAMBLE}\nCurrent time: 2026-10-20T09:03:00Z`);
    // No breakpoint may sit after the volatile tail — so no message breakpoint.
    const messages = JSON.stringify((reduced as { messages: unknown }).messages);
    expect(messages).not.toContain("cache_control");
  });

  it("preserves the separating newline when the moved tail has two lines", () => {
    // Regression: the stable/tail split once dropped the newline that used to
    // sit between the stable text and the relocated line(s), gluing the last
    // stable character to the first tail character — a silent content change,
    // not just a cache-boundary change. Two moved lines makes that character
    // loss visible even if a single-line tail happened to read fine.
    const request = {
      model: "claude-sonnet-5-5",
      max_tokens: 400,
      system: `Current time: 2026-10-20T09:03:00Z\nRequest id: 8f14e45f-cea6-4f9a-b123-456789abcdef\n${PREAMBLE}`,
      messages: [
        { role: "user", content: "Step 0: continue the refactor." },
        { role: "assistant", content: "Done with step 0." },
        { role: "user", content: "Step 1: continue the refactor." },
      ],
    };
    const { request: reduced } = reduceRequest(request, { ...config });
    const system = (reduced as { system: Array<{ text: string; cache_control?: unknown }> }).system;
    expect(system).toHaveLength(2);
    expect(`${system[0]!.text}${system[1]!.text}`).toEqual(
      `${PREAMBLE}\nCurrent time: 2026-10-20T09:03:00Z\nRequest id: 8f14e45f-cea6-4f9a-b123-456789abcdef`,
    );
  });

  it("keeps the single-block stamp and the message breakpoint when the system has no volatile tail", () => {
    const { request: reduced } = reduceRequest(turn(3), { ...config });
    const system = (reduced as { system: Array<{ cache_control?: unknown }> }).system;
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    const messages = (reduced as { messages: Array<{ content: unknown }> }).messages;
    expect(JSON.stringify(messages.at(-1))).toContain("cache_control");
  });

  it("stamps nothing when the whole system is volatile", () => {
    const request = {
      model: "claude-sonnet-5-5",
      system: "Current time: 2026-10-20T09:03:00Z",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    };
    const { request: reduced } = reduceRequest(request, { ...config });
    expect(JSON.stringify(reduced)).not.toContain("cache_control");
  });

  it("withholds the stamp when the guard reports churn, and records why", () => {
    const guard = new CachePrefixVolatilityGuard();
    const shared = { ...config, cacheVolatilityGuard: guard };
    const first = reduceRequest(turn(0, "09:00:00Z"), shared);
    expect(JSON.stringify(first.request)).toContain("cache_control");
    const second = reduceRequest(turn(1, "09:05:00Z"), shared);
    expect(JSON.stringify(second.request)).not.toContain("cache_control");
    const suppression = second.summary.changes.find((change) => change.lever === "cache-ttl-suppressed");
    expect(suppression).toBeDefined();
    expect(suppression!.detail).toContain("never reads");
    expect(second.summary.changes.find((change) => change.lever === "cache-ttl-5m")).toBeUndefined();
  });

  // The 2026-10-26 live coding-agent spool: a full ISO clock in the system
  // (which prefix repair relocates) and a history the client rebuilds each
  // turn. The guard used to withhold everything from turn 3 on while the
  // provider had the stable prefix cached; these pin the corrected behaviour.
  const liveShaped = (turnIndex: number, rebuilt: boolean): Record<string, unknown> => {
    const base = turn(turnIndex, `2026-10-13T09:0${turnIndex}:00Z`) as { messages: Array<Record<string, unknown>> };
    if (rebuilt && turnIndex > 0) {
      base.messages[1] = { role: "assistant", content: `Summary as of turn ${turnIndex}.` };
    }
    return base;
  };
  const stripStamps = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)));

  it("keeps the system breakpoint on every turn when repair has moved the per-turn clock out of it", () => {
    const shared = { ...config, cacheVolatilityGuard: new CachePrefixVolatilityGuard() };
    for (let index = 0; index < 6; index += 1) {
      const { request: reduced, summary } = reduceRequest(liveShaped(index, false), shared);
      const system = (reduced as { system: Array<{ text: string; cache_control?: unknown }> }).system;
      expect(system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
      expect(system[0]!.text).toEqual(`${PREAMBLE}\n`);
      expect(summary.changes.some((change) => change.lever === "cache-ttl-5m")).toBe(true);
    }
  });

  it("keeps the system breakpoint when the client rewrites its history, and withholds only the message one", () => {
    const shared = { cacheTtl: "5m", cacheVolatilityGuard: new CachePrefixVolatilityGuard() } as const;
    const first = reduceRequest(turn(2), shared);
    expect(JSON.stringify((first.request as { messages: unknown }).messages)).toContain("cache_control");
    const rewritten = turn(2) as { messages: Array<Record<string, unknown>> };
    rewritten.messages[1] = { role: "assistant", content: "[summarised by the client framework]" };
    const second = reduceRequest(rewritten, shared);
    const reduced = second.request as { system: Array<{ cache_control?: unknown }>; messages: unknown };
    expect(reduced.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(JSON.stringify(reduced.messages)).not.toContain("cache_control");
    const note = second.summary.changes.find((change) => change.lever === "cache-ttl-suppressed");
    expect(note!.detail).toContain("newest message withheld");
    expect(second.summary.changes.some((change) => change.lever === "cache-ttl-5m")).toBe(true);
  });

  it("changes only where breakpoints go: with the markers removed, the guarded request equals the unguarded one", () => {
    // The quality argument, as a test. Whatever the guard decides, the model
    // must be sent exactly the content the existing (unguarded) stamp sends.
    const guarded = { ...config, cacheVolatilityGuard: new CachePrefixVolatilityGuard() };
    for (const rebuilt of [false, true]) {
      for (let index = 0; index < 6; index += 1) {
        const raw = liveShaped(index, rebuilt);
        const withGuard = reduceRequest(raw, guarded).request as { system: unknown; messages: unknown };
        const without = reduceRequest(raw, { ...config }).request as { system: unknown; messages: unknown };
        const text = (system: unknown): string => Array.isArray(system)
          ? (system as Array<{ text: string }>).map((block) => block.text).join("")
          : String(system);
        expect(text(withGuard.system)).toEqual(text(without.system));
        expect(stripStamps(withGuard.messages)).toEqual(stripStamps(without.messages));
      }
    }
  });
});

/**
 * Placement economics, modelled on Anthropic's documented billing rules
 * (cache reads are exact-span prefix matches at 0.1x base input; writes bill
 * the span at 1.25x for the 5m TTL; everything after the last breakpoint
 * bills at 1x). This is the arithmetic the second live export measured: the
 * old placement lost money on a volatile-clock agent; the fixed placement
 * must earn on the same traffic.
 */
describe("stamp placement economics on a volatile-clock agent", () => {
  const RATE = 2 / 1_000_000; // catalogued claude-sonnet-5-5 input rate, USD per token
  const tokens = (text: string): number => Math.ceil(text.length / 4);

  /** Serialize a stamped request into cumulative spans ending at each breakpoint. */
  function breakpointSpans(request: Record<string, unknown>): { spans: string[]; full: string } {
    let running = "";
    const spans: string[] = [];
    const walkBlocks = (blocks: unknown): void => {
      if (typeof blocks === "string") { running += blocks; return; }
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        running += typeof b.text === "string" ? b.text : JSON.stringify(b);
        if (b.cache_control !== undefined) spans.push(running);
      }
    };
    walkBlocks(request.system);
    for (const message of request.messages as Array<Record<string, unknown>>) {
      if (typeof message.content === "string") running += message.content;
      else walkBlocks(message.content);
    }
    return { spans, full: running };
  }

  /** Price a turn sequence: exact-span reads at 0.1x, span writes at 1.25x, the rest at 1x. */
  function price(turnsStamped: Array<Record<string, unknown>>): number {
    const written = new Set<string>();
    let cost = 0;
    for (const request of turnsStamped) {
      const { spans, full } = breakpointSpans(request);
      let readChars = 0;
      for (const span of spans) if (written.has(span)) readChars = Math.max(readChars, span.length);
      const lastSpanChars = spans.length > 0 ? spans[spans.length - 1]!.length : 0;
      const writeChars = Math.max(0, lastSpanChars - readChars);
      const freshChars = full.length - lastSpanChars;
      cost += tokens(full.slice(0, readChars)) * RATE * 0.1;
      cost += tokens(full.slice(readChars, lastSpanChars)) * RATE * 1.25;
      cost += tokens(full.slice(lastSpanChars)) * RATE;
      for (const span of spans) written.add(span);
    }
    return cost;
  }

  it("the old placement loses money and the fixed placement earns, on identical traffic", () => {
    const TURNS = 6;
    // The live export's clock shape: a full ISO timestamp, which prefix
    // repair recognises and relocates. (A clock repair cannot recognise is
    // the volatility guard's job, covered above.)
    const raw = Array.from({ length: TURNS }, (_, index) => turn(index, `2026-10-20T09:0${index}:00Z`));
    const uncached = raw.reduce((sum, request) => {
      const body = `${request.system as string}${(request.messages as Array<{ content: string }>).map((m) => m.content).join("")}`;
      return sum + tokens(body) * RATE;
    }, 0);

    // OLD: one breakpoint over the whole system (volatile clock inside the
    // cached span) plus one on the last message — the shipped behaviour the
    // live export measured losing.
    const oldStamped = raw.map((request) => ({
      ...request,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral", ttl: "5m" } }],
      messages: (request.messages as Array<Record<string, unknown>>).map((message, index, all) =>
        index === all.length - 1
          ? { ...message, content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral", ttl: "5m" } }] }
          : message),
    }));
    const oldCost = price(oldStamped);

    // NEW: the reducer's split placement on the same raw turns.
    const newStamped = raw.map((request) =>
      reduceRequest(request, { repairCachePrefix: true, cacheTtl: "5m" }).request as Record<string, unknown>);
    const newCost = price(newStamped);

    expect(oldCost).toBeGreaterThan(uncached);  // the measured loss
    expect(newCost).toBeLessThan(uncached);     // the fix earns on the same traffic
    expect(newCost).toBeLessThan(oldCost * 0.6);
  });
});
