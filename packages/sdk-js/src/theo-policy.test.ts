import { describe, expect, it } from "vitest";
import {
  defaultPolicy,
  policyToReductionConfig,
  withheldLevers,
  publishLever,
  policyCoverage,
  knownLeverIds,
  ENFORCEABLE_LEVERS,
  routeMatches,
  isPolicyBundle,
  asBundle,
  policyForRoute,
  bundleToReductionConfig,
  upsertRoutePolicy,
  type TheoPolicy,
  type TheoPolicyBundle,
  type TheoLever,
  type TheoGateProof,
} from "./theo-policy.js";

const AT = "2026-10-29T00:00:00.000Z";

describe("Theo policy", () => {
  it("a new user's default policy is STRICT and lossless-only", () => {
    const p = defaultPolicy("u1", AT);
    expect(p.qualityCeilingPercent).toBe(2);
    expect(p.levers.every((l) => l.class === "lossless")).toBe(true);
    const config = policyToReductionConfig(p);
    expect(config.toolSchemas).toBe(true);
    expect(config.duplicateContext).toBe(true);
    expect(config.repairCachePrefix).toBe(true);
    expect(config.outputEffort).toBeUndefined();
  });

  it("applies lossless levers unconditionally", () => {
    const p: TheoPolicy = { ...defaultPolicy("u", AT), levers: [{ lever: "cache-prefix-repair", class: "lossless" }] };
    expect(policyToReductionConfig(p).repairCachePrefix).toBe(true);
  });

  it("hard-caps the quality ceiling: a lever past the max is withheld even if the policy ceiling is higher", () => {
    const over: TheoLever = { lever: "output-effort-low", class: "lossy", gate: { savingPercent: 30, qualityDeltaPercent: -6, grader: "g", provenAt: AT } };
    const p: TheoPolicy = { ...defaultPolicy("u", AT), qualityCeilingPercent: 20, levers: [over] };
    expect(policyToReductionConfig(p).outputEffort).toBeUndefined(); // 6% drop > hard max, withheld
    expect(withheldLevers(p)[0]?.reason).toContain("ceiling");
    const under: TheoLever = { ...over, gate: { savingPercent: 30, qualityDeltaPercent: -4, grader: "g", provenAt: AT } };
    const p2: TheoPolicy = { ...p, levers: [under] };
    expect(policyToReductionConfig(p2).outputEffort).toBe("low"); // 4% ≤ hard max, enforced
  });

  it("WITHHOLDS a lossy lever that carries no gate proof", () => {
    const p: TheoPolicy = { ...defaultPolicy("u", AT), levers: [{ lever: "output-effort-low", class: "lossy" }] };
    expect(policyToReductionConfig(p).outputEffort).toBeUndefined();
    expect(withheldLevers(p)[0]?.reason).toContain("no gate proof");
  });

  it("WITHHOLDS a lossy lever whose measured quality drop exceeds the route ceiling", () => {
    const lever: TheoLever = {
      lever: "output-effort-low", class: "lossy",
      gate: { savingPercent: 12, qualityDeltaPercent: -5, grader: "task-completion", provenAt: AT },
    };
    const p: TheoPolicy = { ...defaultPolicy("u", AT), qualityCeilingPercent: 2, levers: [lever] };
    expect(policyToReductionConfig(p).outputEffort).toBeUndefined();
    expect(withheldLevers(p)[0]?.reason).toContain("exceeds the 2% ceiling");
  });

  it("APPLIES a lossy lever proven within the ceiling", () => {
    const lever: TheoLever = {
      lever: "output-effort-low", class: "lossy",
      gate: { savingPercent: 5, qualityDeltaPercent: -0.3, grader: "task-completion", provenAt: AT },
    };
    const p: TheoPolicy = { ...defaultPolicy("u", AT), qualityCeilingPercent: 2, levers: [lever] };
    expect(policyToReductionConfig(p).outputEffort).toBe("low");
    expect(withheldLevers(p)).toHaveLength(0);
  });

  it("maps params for parameterised levers", () => {
    const p: TheoPolicy = {
      ...defaultPolicy("u", AT),
      levers: [
        { lever: "cache-ttl-5m", class: "lossless" },
        { lever: "fresh-tool-result-cap", class: "lossy", params: { maximumTokens: 600 },
          gate: { savingPercent: 4, qualityDeltaPercent: -0.5, grader: "tests", provenAt: AT } },
      ],
    };
    const config = policyToReductionConfig(p);
    expect(config.cacheTtl).toBe("5m");
    expect(config.freshToolResultCap).toEqual({ maximumTokens: 600 });
  });

  it("publishLever bumps the version, refuses lossy without proof, and never mutates the input", () => {
    const p = defaultPolicy("u", AT);
    const next = publishLever(p, { lever: "cache-ttl-5m", class: "lossless" }, "2026-10-29T01:00:00.000Z");
    expect(next.version).toBe(p.version + 1);
    expect(p.levers.some((l) => l.lever === "cache-ttl-5m")).toBe(false); // input untouched
    expect(next.levers.some((l) => l.lever === "cache-ttl-5m")).toBe(true);
    expect(() => publishLever(p, { lever: "output-effort-low", class: "lossy" }, AT)).toThrow(/without a gate proof/);
  });
});

describe("policyCoverage", () => {
  it("ENFORCEABLE_LEVERS stays in sync with knownLeverIds (every id in exactly one group)", () => {
    const known = knownLeverIds().sort();
    const members = ENFORCEABLE_LEVERS.flatMap((group) => group.members).sort();
    expect(members).toEqual(known); // same set, no duplicates, nothing missing
    expect(new Set(members).size).toBe(members.length);
  });

  it("the default policy is active on its three lossless levers and the rest are available", () => {
    const coverage = policyCoverage(defaultPolicy("u", AT));
    expect(coverage.activeCount).toBe(3); // tool-schema-compaction, duplicate-context-removal, cache-prefix-repair
    expect(coverage.heldCount).toBe(0);
    expect(coverage.enforceableCount).toBe(ENFORCEABLE_LEVERS.length);
    expect(coverage.availableCount).toBe(coverage.enforceableCount - 3);
    expect(coverage.activeCoveragePercent).toBeCloseTo((3 / coverage.enforceableCount) * 100, 6);
    const active = coverage.stands.filter((s) => s.state === "active").map((s) => s.lever).sort();
    expect(active).toEqual(["cache-prefix-repair", "duplicate-context-removal", "tool-schema-compaction"]);
  });

  it("a lossy lever with a passing proof is active; one over the ceiling is held with a reason", () => {
    const policy: TheoPolicy = {
      schemaVersion: 1, user: "u", version: 1, qualityCeilingPercent: 1, updatedAt: AT,
      levers: [
        { lever: "output-effort-low", class: "lossy",
          gate: { savingPercent: 20, qualityDeltaPercent: -0.5, grader: "tests", provenAt: AT } }, // clears 1%
        { lever: "output-cap", class: "lossy",
          gate: { savingPercent: 10, qualityDeltaPercent: -3, grader: "tests", provenAt: AT } },    // over 1%
      ],
    };
    const coverage = policyCoverage(policy);
    const effort = coverage.stands.find((s) => s.lever === "output-effort")!;
    const cap = coverage.stands.find((s) => s.lever === "output-cap")!;
    expect(effort.state).toBe("active");
    expect(cap.state).toBe("held");
    expect(cap.reason).toMatch(/exceeds the 1% ceiling/);
  });

  it("groups mutually-exclusive variants so one cache TTL counts as one active lever", () => {
    const policy: TheoPolicy = {
      schemaVersion: 1, user: "u", version: 1, qualityCeilingPercent: 2, updatedAt: AT,
      levers: [{ lever: "cache-ttl-1h", class: "lossless" }],
    };
    const coverage = policyCoverage(policy);
    const ttl = coverage.stands.find((s) => s.lever === "cache-ttl")!;
    expect(ttl.state).toBe("active");
    expect(coverage.activeCount).toBe(1); // not two, despite two TTL ids existing
  });
});

describe("per-route policy bundles", () => {
  const proven = (y: number): TheoGateProof => ({ savingPercent: 20, qualityDeltaPercent: y, grader: "tests", provenAt: AT });

  it("routeMatches: exact, trailing-* prefix, and catch-all", () => {
    expect(routeMatches("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(true);
    expect(routeMatches("claude-sonnet-5-5", "claude-haiku-5-5")).toBe(false);
    expect(routeMatches("claude-*", "claude-haiku-5-5")).toBe(true);
    expect(routeMatches("claude-*", "gpt-4o")).toBe(false);
    expect(routeMatches("*", "anything")).toBe(true);
    expect(routeMatches("", "anything")).toBe(true);
  });

  it("asBundle wraps a single policy; isPolicyBundle discriminates the two", () => {
    const single = defaultPolicy("u", AT);
    expect(isPolicyBundle(single)).toBe(false);
    const bundle = asBundle(single);
    expect(isPolicyBundle(bundle)).toBe(true);
    expect(bundle.default).toBe(single);
    expect(bundle.routes).toBeUndefined();
    expect(asBundle(bundle)).toBe(bundle); // a bundle passes straight through
  });

  it("policyForRoute returns the FIRST matching route, else the default", () => {
    const def = defaultPolicy("u", AT);
    const cheap: TheoPolicy = { ...def, route: "claude-haiku-5-5", qualityCeilingPercent: 5 };
    const anyClaude: TheoPolicy = { ...def, route: "claude-*", qualityCeilingPercent: 3 };
    const bundle: TheoPolicyBundle = { schemaVersion: 1, user: "u", default: def, routes: [cheap, anyClaude], updatedAt: AT };
    expect(policyForRoute(bundle, "claude-haiku-5-5")).toBe(cheap);   // specific wins (listed first)
    expect(policyForRoute(bundle, "claude-sonnet-5-5")).toBe(anyClaude); // falls to the prefix route
    expect(policyForRoute(bundle, "gpt-4o")).toBe(def);               // no route → default
  });

  it("enforces the SELECTED route's levers — a lever proven for one route does not leak to another", () => {
    const def = defaultPolicy("u", AT); // lossless-only
    const loose: TheoPolicy = {
      ...def, route: "claude-haiku-5-5", qualityCeilingPercent: 4,
      levers: [...def.levers, { lever: "output-effort-low", class: "lossy", gate: proven(-1) }],
    };
    const bundle: TheoPolicyBundle = { schemaVersion: 1, user: "u", default: def, routes: [loose], updatedAt: AT };
    // The route that proved the lossy lever gets it...
    expect(bundleToReductionConfig(bundle, "claude-haiku-5-5").outputEffort).toBe("low");
    // ...a different model falls to the default policy and does NOT.
    expect(bundleToReductionConfig(bundle, "claude-sonnet-5-5").outputEffort).toBeUndefined();
  });

  it("each route carries its OWN ceiling, and the hard cap still binds every route", () => {
    const def = defaultPolicy("u", AT);
    // ceiling 2 withholds a 3% drop; same lever clears on a route whose ceiling is 4
    const strict: TheoPolicy = { ...def, route: "gpt-4o", qualityCeilingPercent: 2,
      levers: [{ lever: "output-effort-low", class: "lossy", gate: proven(-3) }] };
    const loose: TheoPolicy = { ...strict, route: "claude-*", qualityCeilingPercent: 4 };
    // and the hard cap (5%) overrides a route that sets an absurd ceiling
    const reckless: TheoPolicy = { ...strict, route: "claude-opus-5-5", qualityCeilingPercent: 50,
      levers: [{ lever: "output-effort-low", class: "lossy", gate: proven(-6) }] };
    // specific routes before the catch-all prefix (first match wins)
    const bundle: TheoPolicyBundle = { schemaVersion: 1, user: "u", default: def, routes: [strict, reckless, loose], updatedAt: AT };
    expect(bundleToReductionConfig(bundle, "gpt-4o").outputEffort).toBeUndefined(); // 3% > 2% route ceiling
    expect(bundleToReductionConfig(bundle, "claude-sonnet-5-5").outputEffort).toBe("low"); // 3% ≤ 4%
    expect(bundleToReductionConfig(bundle, "claude-opus-5-5").outputEffort).toBeUndefined(); // 6% > hard cap 5%
  });

  it("upsertRoutePolicy adds then replaces a route, never mutating the input, and refuses a routeless policy", () => {
    const bundle = asBundle(defaultPolicy("u", AT));
    const r1: TheoPolicy = { ...bundle.default, route: "gpt-4o", qualityCeilingPercent: 3 };
    const added = upsertRoutePolicy(bundle, r1, "2026-10-29T02:00:00.000Z");
    expect(added.routes).toHaveLength(1);
    expect(bundle.routes).toBeUndefined(); // input untouched
    const r2: TheoPolicy = { ...r1, qualityCeilingPercent: 1 };
    const replaced = upsertRoutePolicy(added, r2, "2026-10-29T03:00:00.000Z");
    expect(replaced.routes).toHaveLength(1); // replaced, not appended
    expect(replaced.routes![0]?.qualityCeilingPercent).toBe(1);
    expect(() => upsertRoutePolicy(bundle, bundle.default, AT)).toThrow(/route/);
  });
});
