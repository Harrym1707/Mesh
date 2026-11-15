import { describe, expect, it } from "vitest";
import {
  defaultPolicy,
  policyToReductionConfig,
  withheldLevers,
  publishLever,
  gateProofFrom,
  policyCoverage,
  knownLeverIds,
  ENFORCEABLE_LEVERS,
  type TheoPolicy,
  type TheoLever,
} from "./theo-policy.js";
import type { ReplayCandidateResult } from "./replay-gate.js";

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

describe("gateProofFrom", () => {
  const result = (over: Partial<ReplayCandidateResult> = {}): ReplayCandidateResult => ({
    label: "candidate", config: {}, graded: 8, failed: 0,
    meanQualityDelta: 0, lower95QualityDelta: 0, approved: true,
    baselineUsage: { inputTokens: 8000, outputTokens: 400, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    candidateUsage: { inputTokens: 4000, outputTokens: 400, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    inputTokensSaved: 4000, outputTokensSaved: 0, tokenSavingPercent: 47.6,
    ...over,
  });

  it("returns undefined for a candidate the gate did not approve, so it can never be published", () => {
    expect(gateProofFrom(result({ approved: false }), { grader: "tool-selection", at: AT })).toBeUndefined();
  });

  it("packages an approved candidate as a proof, carrying the token saving and the clock", () => {
    const proof = gateProofFrom(result(), { grader: "tool-selection", at: AT })!;
    expect(proof.savingPercent).toBe(47.6);
    expect(proof.qualityDeltaPercent).toBe(0);
    expect(proof.grader).toBe("tool-selection");
    expect(proof.provenAt).toBe(AT);
  });

  it("carries the CONSERVATIVE lower-bound quality delta, not the mean", () => {
    const proof = gateProofFrom(result({ meanQualityDelta: -0.001, lower95QualityDelta: -0.015 }), { grader: "g", at: AT })!;
    expect(proof.qualityDeltaPercent).toBe(-1.5); // the lower bound, as a percent
  });

  it("never records a positive 'drop' when the candidate beat the baseline", () => {
    const proof = gateProofFrom(result({ lower95QualityDelta: 0.01 }), { grader: "g", at: AT })!;
    expect(proof.qualityDeltaPercent).toBe(0);
  });

  it("prefers the money saving over the token saving when a price was known", () => {
    const proof = gateProofFrom(result({ costSavingPercent: 31.2, tokenSavingPercent: 47.6 }), { grader: "g", at: AT })!;
    expect(proof.savingPercent).toBe(31.2);
  });
});
