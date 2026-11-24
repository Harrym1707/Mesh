import { describe, expect, it, vi } from "vitest";
import { corpusAvailable } from "./agent-tasks.js";
import { COMPAT_LEVERS, compatSessions, qualifyCacheCompat, type LeverVerdict } from "./cache-compat.js";
import { layout, priceStream, type AnyObject, type TimedRequest } from "./cache-stream.js";

vi.setConfig({ testTimeout: 120_000 });

const PREFIX = "Stable instructions. ".repeat(400); // well over the cacheable minimum
const marked = (text: string, hour = false): AnyObject => ({
  model: "claude-sonnet-5-5",
  system: [{ type: "text", text: PREFIX, cache_control: { type: "ephemeral", ...(hour ? { ttl: "1h" } : {}) } }],
  messages: [{ role: "user", content: text }],
});
const plain = (text: string): AnyObject => ({ model: "claude-sonnet-5-5", system: PREFIX, messages: [{ role: "user", content: text }] });
const at = (seconds: number, request: AnyObject): TimedRequest => ({ atSeconds: seconds, request, outputTokens: 0 });

describe("priceStream: the provider's cache rules", () => {
  it("lays a request out without its cache markers, and records where they sit", () => {
    const withMarker = layout(marked("Hello."));
    const without = layout({ ...marked("Hello."), system: [{ type: "text", text: PREFIX }] });
    expect(withMarker.content).toBe(without.content);
    expect(withMarker.breakpoints).toHaveLength(1);
    expect(without.breakpoints).toHaveLength(0);
    expect(layout({ ...plain("Hello."), cache_control: { type: "ephemeral" } }).automatic).toBe(true);
  });

  it("charges every token at the plain rate when nothing is marked", () => {
    const priced = priceStream([at(0, plain("One.")), at(20, plain("Two."))]);
    expect(priced.readTokens).toBe(0);
    expect(priced.writeTokens).toBe(0);
    expect(priced.inputUnits).toBeCloseTo(priced.inputTokens, 6);
  });

  it("writes once at 1.25x and then reads at a tenth", () => {
    const priced = priceStream([at(0, marked("One.")), at(20, marked("Two.")), at(40, marked("Three."))]);
    const prefixTokens = priced.writeTokens;
    expect(prefixTokens).toBeGreaterThan(1_024);
    expect(priced.readTokens).toBe(prefixTokens * 2);
    const rest = priced.inputTokens - prefixTokens * 3;
    expect(priced.inputUnits).toBeCloseTo(prefixTokens * 1.25 + prefixTokens * 2 * 0.1 + rest, 6);
  });

  it("an entry expires five minutes after its last read, and a read keeps it alive", () => {
    const expired = priceStream([at(0, marked("One.")), at(301, marked("Two."))]);
    expect(expired.readTokens).toBe(0);
    const keptAlive = priceStream([at(0, marked("One.")), at(200, marked("Two.")), at(400, marked("Three."))]);
    expect(keptAlive.readTokens).toBe(keptAlive.writeTokens * 2);
  });

  it("requests sent together each pay the write: nothing is readable until its writer has answered", () => {
    const together = priceStream([at(0, marked("One.")), at(0, marked("Two.")), at(1, marked("Three."))]);
    expect(together.readTokens).toBe(0);
    const staggered = priceStream([at(0, marked("One.")), at(5, marked("Two.")), at(10, marked("Three."))]);
    expect(staggered.readTokens).toBeGreaterThan(0);
    expect(together.inputUnits).toBeGreaterThan(staggered.inputUnits * 2);
  });

  it("the hour-long lifetime doubles the write and outlives a six-minute gap", () => {
    const five = priceStream([at(0, marked("One.")), at(360, marked("Two."))]);
    const hour = priceStream([at(0, marked("One.", true)), at(360, marked("Two.", true))]);
    expect(five.readTokens).toBe(0);
    expect(hour.readTokens).toBeGreaterThan(0);
    expect(hour.inputUnits).toBeLessThan(five.inputUnits);
    const firstWriteOnly = priceStream([at(0, marked("One.", true))]);
    expect(firstWriteOnly.inputUnits).toBeGreaterThan(priceStream([at(0, marked("One."))]).inputUnits);
  });
});

describe.skipIf(!corpusAvailable())("cache compatibility of every lever", () => {
  let verdicts: LeverVerdict[] | undefined;
  const all = (): LeverVerdict[] => (verdicts ??= qualifyCacheCompat());
  const verdict = (id: string): LeverVerdict => all().find((entry) => entry.lever === id)!;
  const SHIPPED = COMPAT_LEVERS.filter((lever) => !lever.id.endsWith(":forced")).map((lever) => lever.id);

  it("covers clients that do not cache, that place breakpoints, and that use automatic caching", () => {
    const sessions = compatSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(20);
    for (const mode of ["none", "breakpoints", "automatic"] as const) {
      expect(sessions.some((session) => session.callerCache === mode)).toBe(true);
    }
    for (const session of sessions) expect(session.requests.length).toBeGreaterThanOrEqual(4);
  });

  it("every lever acts on at least one session, so a pass is not a lever that did nothing", () => {
    for (const id of SHIPPED) expect(verdict(id).sessionsActedOn, id).toBeGreaterThan(0);
  });

  it("CHECK A: no lever, as shipped, breaks a prefix the provider is caching", () => {
    for (const id of SHIPPED) {
      expect(verdict(id).brokenCachedSessions, id).toEqual([]);
      expect(verdict(id).prefixStableWhereCached, id).toBe(true);
    }
  });

  it("CHECK C: no lever, on from the first turn, raises the billed input cost of a cached conversation", () => {
    for (const id of SHIPPED) {
      for (const row of verdict(id).rows.filter((entry) => entry.cached && entry.acted)) {
        expect(row.billChangePercent, `${id} on ${row.session}`).toBeGreaterThanOrEqual(-0.05);
      }
    }
  });

  it("the three defaults are stable everywhere and never raise a bill", () => {
    const defaults = verdict("defaults");
    expect(defaults.prefixStableEverywhere).toBe(true);
    for (const row of defaults.rows) expect(row.billChangePercent, row.session).toBeGreaterThanOrEqual(-0.05);
  });

  it("history compaction is the lever that WOULD break a cache: with its gate overridden it raises the bill while removing tokens", () => {
    const forced = verdict("stale-history-compaction:forced");
    expect(forced.prefixStableWhereCached).toBe(false);
    expect(forced.brokenCachedSessions.length).toBeGreaterThanOrEqual(3);
    const hurt = forced.rows.filter((row) => row.cached && row.billChangePercent < -5);
    expect(hurt.length).toBeGreaterThanOrEqual(3);
    for (const row of hurt) expect(row.tokenChangePercent, row.session).toBeGreaterThan(5); // fewer tokens, higher bill
    expect(forced.worstCallerCachedBillChangePercent).toBeLessThan(-50);
  });

  it("the gate removes that loss and leaves the uncached saving in place", () => {
    const gated = verdict("stale-history-compaction");
    expect(gated.rows.filter((row) => row.cached && row.acted)).toEqual([]);
    const uncached = gated.rows.filter((row) => !row.cached && row.acted);
    expect(uncached.length).toBeGreaterThanOrEqual(3);
    for (const row of uncached) expect(row.billChangePercent, row.session).toBeGreaterThan(5);
    // On top of Mesh's own stamp it now acts only where the history is not cached, and pays there.
    const onStamp = verdict("stale-history-compaction+cache-stamp");
    for (const row of onStamp.rows.filter((entry) => entry.acted)) expect(row.billChangePercent, row.session).toBeGreaterThan(0);
  });

  it("CHECK B: levers do change bytes the caller cached, the same way every turn - a one-off re-write if switched on mid-conversation", () => {
    // Recorded so the cost is known, not hidden: switching these on halfway
    // through a cached conversation re-writes its prefix once.
    for (const id of ["tool-schema-compaction", "tool-result-json-compaction", "tool-schema-description-trim"]) {
      expect(verdict(id).callerPrefixTouchedIn.length, id).toBeGreaterThan(0);
      expect(verdict(id).worstMidSessionBillChangePercent, id).toBeLessThan(-10);
      expect(verdict(id).worstCallerCachedBillChangePercent, id).toBeGreaterThanOrEqual(-0.05); // fine when on from the start
    }
    // The stamp and the gated compaction never touch them.
    expect(verdict("cache-ttl-5m").callerPrefixTouchedIn).toEqual([]);
    expect(verdict("stale-history-compaction").callerPrefixTouchedIn).toEqual([]);
  });
});
