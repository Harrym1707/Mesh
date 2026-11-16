import { describe, expect, it } from "vitest";
import { theoLeverIds } from "./theo-agent.js";
import {
  asBundle,
  bundleToReductionConfig,
  defaultPolicy,
  keptOperatorLevers,
  knownLeverIds,
  mergePolicyIntoBundle,
  policyToReductionConfig,
  type TheoGateProof,
  type TheoLever,
  type TheoPolicy,
  type TheoPolicyBundle,
} from "./theo-policy.js";

/**
 * A lever a person added to the policy file by hand survives Theo writing his
 * own policy over it. Theo runs with apply on in the background of `mesh
 * start`, so before this an opt-in lever was gone within one cycle.
 */

const AT = "2026-11-16T00:00:00.000Z";
const LATER = "2026-11-16T01:00:00.000Z";
const OWNED = theoLeverIds();
const proof = (qualityDeltaPercent: number): TheoGateProof =>
  ({ savingPercent: 10, qualityDeltaPercent, grader: "tests", provenAt: AT });

const JSON_LEVER: TheoLever = { lever: "tool-result-json-compaction", class: "lossless" };
const CACHE_LEVER: TheoLever = { lever: "cache-ttl-5m", class: "lossless" };
const DROP_TOOLS: TheoLever = { lever: "unused-tool-removal", class: "lossy", params: { tools: ["legacy_search"] }, gate: proof(-0.5) };

/** What Theo holds in memory: the default policy, which has never heard of the file's extras. */
const theoPolicy = (extra: TheoLever[] = [], version = 2): TheoPolicy => {
  const base = defaultPolicy("local", AT);
  return { ...base, version, levers: [...base.levers, ...extra] };
};
const stored = (extra: unknown[]): TheoPolicyBundle => {
  const base = defaultPolicy("local", AT);
  return asBundle({ ...base, levers: [...base.levers, ...(extra as TheoLever[])] });
};
const ids = (policy: TheoPolicy): string[] => policy.levers.map((lever) => lever.lever);

describe("theoLeverIds", () => {
  it("is the default policy's levers plus the ones Theo can prove, and nothing an operator opts into", () => {
    expect([...OWNED].sort()).toEqual([
      "cache-prefix-repair",
      "duplicate-context-removal",
      "output-effort-low",
      "stale-history-compaction",
      "tool-schema-compaction",
      "tool-schema-description-trim",
    ]);
    for (const id of OWNED) expect(knownLeverIds()).toContain(id);
    expect(OWNED).not.toContain("tool-result-json-compaction");
    expect(OWNED).not.toContain("cache-ttl-5m");
  });
});

describe("a lever added by hand survives Theo's policy being applied", () => {
  it("keeps it on the default route, after Theo's own levers, and it is still enforced", () => {
    const existing = stored([JSON_LEVER, CACHE_LEVER, DROP_TOOLS]);
    const merged = mergePolicyIntoBundle(existing, theoPolicy(), undefined, LATER, { theoLeverIds: OWNED });
    expect(ids(merged.default)).toEqual([
      "tool-schema-compaction", "duplicate-context-removal", "cache-prefix-repair",
      "tool-result-json-compaction", "cache-ttl-5m", "unused-tool-removal",
    ]);
    expect(merged.default.version).toBe(2); // Theo's version, not the file's
    const config = policyToReductionConfig(merged.default);
    expect(config.toolResultJson).toBe(true);
    expect(config.cacheTtl).toBe("5m");
    expect(config.dropTools).toEqual(["legacy_search"]);
    // The kept entries are the operator's own objects, params and proof included.
    expect(merged.default.levers.at(-1)).toEqual(DROP_TOOLS);
  });

  it("without theoLeverIds the policy still replaces the old one whole", () => {
    const merged = mergePolicyIntoBundle(stored([JSON_LEVER]), theoPolicy(), undefined, LATER);
    expect(ids(merged.default)).toEqual(["tool-schema-compaction", "duplicate-context-removal", "cache-prefix-repair"]);
  });

  it("applying again and again changes nothing and never duplicates", () => {
    let bundle = stored([JSON_LEVER]);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      bundle = mergePolicyIntoBundle(bundle, theoPolicy([], 2 + cycle), undefined, LATER, { theoLeverIds: OWNED });
      expect(ids(bundle.default)).toEqual([
        "tool-schema-compaction", "duplicate-context-removal", "cache-prefix-repair", "tool-result-json-compaction",
      ]);
    }
  });

  it("a lever Theo rolled back stays out, even though the file still lists it", () => {
    const published: TheoLever = { lever: "stale-history-compaction", class: "lossy", gate: proof(-0.4) };
    // The file was written while the lever was live; Theo has since removed it.
    const existing = stored([published, JSON_LEVER]);
    const merged = mergePolicyIntoBundle(existing, theoPolicy(), undefined, LATER, { theoLeverIds: OWNED });
    expect(ids(merged.default)).not.toContain("stale-history-compaction");
    expect(ids(merged.default)).toContain("tool-result-json-compaction");
    expect(policyToReductionConfig(merged.default).historyCompaction).toBeUndefined();
  });

  it("Theo's own version of a lever wins over the file's copy of the same id", () => {
    const fromFile: TheoLever = { lever: "cache-ttl-5m", class: "lossless", params: { note: "operator" } };
    const fromTheo: TheoLever = { lever: "cache-ttl-5m", class: "lossless", params: { note: "theo" } };
    const merged = mergePolicyIntoBundle(stored([fromFile]), theoPolicy([fromTheo]), undefined, LATER, { theoLeverIds: OWNED });
    expect(merged.default.levers.filter((lever) => lever.lever === "cache-ttl-5m")).toEqual([fromTheo]);
  });

  it("an operator's lever gives way to one Theo proved in the same exclusive group", () => {
    const operators: TheoLever = { lever: "output-effort-medium", class: "lossy", gate: proof(-1) };
    const theos: TheoLever = { lever: "output-effort-low", class: "lossy", gate: proof(-1.5) };
    const existing = stored([operators, { lever: "cache-ttl-1h", class: "lossless" }]);

    const withoutTheos = mergePolicyIntoBundle(existing, theoPolicy(), undefined, LATER, { theoLeverIds: OWNED });
    expect(policyToReductionConfig(withoutTheos.default).outputEffort).toBe("medium");
    expect(policyToReductionConfig(withoutTheos.default).cacheTtl).toBe("1h");

    const withTheos = mergePolicyIntoBundle(existing, theoPolicy([theos]), undefined, LATER, { theoLeverIds: OWNED });
    expect(ids(withTheos.default)).not.toContain("output-effort-medium");
    expect(policyToReductionConfig(withTheos.default).outputEffort).toBe("low");
    expect(policyToReductionConfig(withTheos.default).cacheTtl).toBe("1h"); // a different group is untouched
  });

  it("keeping a lossy lever does not enforce it without a proof inside the ceiling", () => {
    const unproven: TheoLever = { lever: "fresh-tool-result-cap", class: "lossy" };
    const tooLossy: TheoLever = { lever: "cross-turn-memory-dedup", class: "lossy", gate: proof(-4) };
    const merged = mergePolicyIntoBundle(stored([unproven, tooLossy]), theoPolicy(), undefined, LATER, { theoLeverIds: OWNED });
    expect(ids(merged.default)).toEqual(expect.arrayContaining(["fresh-tool-result-cap", "cross-turn-memory-dedup"]));
    const config = policyToReductionConfig(merged.default);
    expect(config.freshToolResultCap).toBeUndefined();
    expect(config.crossTurnMemoryDedup).toBeUndefined(); // 4% drop against a 2% ceiling
  });

  it("keeps a lever this build does not know, and ignores entries that are not levers", () => {
    const fromANewerBuild = { lever: "some-future-lever", class: "lossless", params: { x: 1 } };
    const existing = stored([null, "tool-result-json-compaction", 7, {}, { lever: 3 }, { lever: "" }, fromANewerBuild, JSON_LEVER, JSON_LEVER]);
    const merged = mergePolicyIntoBundle(existing, theoPolicy(), undefined, LATER, { theoLeverIds: OWNED });
    expect(merged.default.levers.slice(3)).toEqual([fromANewerBuild, JSON_LEVER]);
  });

  it("a stored policy with no usable lever list keeps nothing and does not throw", () => {
    const broken = { schemaVersion: 1, user: "local", default: { ...defaultPolicy("local", AT), levers: "oops" }, updatedAt: AT } as unknown as TheoPolicyBundle;
    expect(keptOperatorLevers(broken, theoPolicy(), undefined, OWNED)).toEqual([]);
    expect(keptOperatorLevers(undefined, theoPolicy(), undefined, OWNED)).toEqual([]);
    expect(ids(mergePolicyIntoBundle(broken, theoPolicy(), undefined, LATER, { theoLeverIds: OWNED }).default)).toHaveLength(3);
  });

  it("never mutates the stored bundle or Theo's policy", () => {
    const existing = stored([JSON_LEVER]);
    const incoming = theoPolicy();
    const before = [JSON.stringify(existing), JSON.stringify(incoming)];
    mergePolicyIntoBundle(existing, incoming, undefined, LATER, { theoLeverIds: OWNED });
    mergePolicyIntoBundle(existing, incoming, "claude-*", LATER, { theoLeverIds: OWNED });
    expect([JSON.stringify(existing), JSON.stringify(incoming)]).toEqual(before);
  });
});

describe("a lever added by hand survives Theo writing a route", () => {
  it("a new route starts with the levers the default gave those models", () => {
    const existing = stored([JSON_LEVER]);
    expect(bundleToReductionConfig(existing, "claude-haiku-5-5").toolResultJson).toBe(true);
    const merged = mergePolicyIntoBundle(existing, theoPolicy(), "claude-haiku*", LATER, { theoLeverIds: OWNED });
    expect(merged.default).toBe(existing.default); // the default itself is untouched
    expect(merged.routes).toHaveLength(1);
    // The same model is still compacted after Theo gives it a route of its own.
    expect(bundleToReductionConfig(merged, "claude-haiku-5-5").toolResultJson).toBe(true);
    expect(bundleToReductionConfig(merged, "claude-sonnet-5-5").toolResultJson).toBe(true);
  });

  it("an existing route keeps its own hand-added levers, not the default's", () => {
    const base = defaultPolicy("local", AT);
    const existing: TheoPolicyBundle = {
      schemaVersion: 1,
      user: "local",
      default: { ...base, levers: [...base.levers, JSON_LEVER] },
      routes: [
        { ...base, route: "claude-haiku*", levers: [...base.levers, CACHE_LEVER] },
        { ...base, route: "gpt-*", levers: [...base.levers, DROP_TOOLS] },
      ],
      updatedAt: AT,
    };
    const merged = mergePolicyIntoBundle(existing, theoPolicy(), "claude-haiku*", LATER, { theoLeverIds: OWNED });
    const haiku = merged.routes!.find((route) => route.route === "claude-haiku*")!;
    expect(ids(haiku)).toEqual(["tool-schema-compaction", "duplicate-context-removal", "cache-prefix-repair", "cache-ttl-5m"]);
    // Every other route, and the default, are exactly what they were.
    expect(merged.routes!.find((route) => route.route === "gpt-*")).toBe(existing.routes![1]);
    expect(merged.default).toBe(existing.default);
  });
});
