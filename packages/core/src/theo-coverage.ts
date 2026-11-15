import { estimateTokenCost, type TokenPrice } from "./cost.js";
import {
  leversFor,
  projectSavings,
  PUBLISHED_LEVERS,
  type Lever,
  type LeverRisk,
  type WorkloadProfile,
} from "./savings-model.js";

/**
 * Theo coverage oracle — how much of the catalogue Theo actually reaches.
 *
 * The honest answer to "how do we know Theo found the savings?" is not to trust
 * that he thought of everything, but to make his coverage measurable. Theo does
 * not invent levers; he runs a fixed catalogue (PUBLISHED_LEVERS) against your
 * traffic. So his effectiveness is: of the catalogue levers that could touch this
 * workload, how many does he apply, and for each one he does not, exactly why.
 *
 * This module answers that for a given workload profile. It does NOT invent a
 * single dollar "achievable maximum": summing published reduction factors into
 * one ceiling would itself be a guess, and the whole project argues against
 * guesses dressed as measurements. Instead the headline is lever coverage (M of
 * N applicable levers), and every unapplied lever carries its own standalone
 * projected headroom, labelled for what it is — a hypothesis from the lever's
 * published evidence, not a realised saving. Realised savings only ever come
 * from provider-reported usage priced through the catalogue, as everywhere else.
 */

/**
 * Levers the catalogue carries but the local proxy cannot apply, because they
 * replace the tool catalogue with a router or a sandbox and so require rebuilding
 * the agent itself. Their headroom is real but it is the customer's engineers to
 * capture, not Theo's to apply silently. Keyed by Lever.id.
 */
const ARCHITECTURE_LEVERS: Record<string, string> = {
  "progressive-disclosure":
    "Architecture change: replaces the tool catalogue with a search/meta tool the agent must query, " +
    "adding a round trip per novel tool call. The proxy cannot do this transparently — it is a change " +
    "to how the agent is built, so the headroom is flagged for your engineers rather than auto-applied.",
  "code-mode":
    "Architecture change: needs a code sandbox and meta-tools so the model orchestrates tools in code " +
    "instead of seeing their definitions. The proxy cannot introduce a sandbox transparently, so the " +
    "headroom is flagged for your engineers rather than auto-applied.",
};

/**
 * Levers the proxy CAN apply transparently but holds off the default stack,
 * because they overlap a lever already in it and must be proven to beat it on the
 * customer's own traffic before Theo switches. Their headroom is Theo's to
 * capture — once the live gate clears — not the customer's engineers'. Keyed by
 * Lever.id, and kept distinct from ARCHITECTURE_LEVERS so the two reasons never
 * blur: an architecture gap needs the customer to rebuild; a held gap needs only
 * the gate to pass.
 */
const HELD_LEVERS: Record<string, string> = {
  "tool-search-defer":
    "Held for the live gate: the proxy applies this transparently (no agent rebuild), but it defers whole " +
    "tool definitions and so overlaps the per-schema tool levers already in Theo's stack — Theo enables it " +
    "only once it is proven on your traffic to beat them within the quality ceiling, never stacked on top " +
    "to double-count the same tokens.",
};

export type LeverCoverage = {
  leverId: string;
  description: string;
  risk: LeverRisk;
  /** The lever targets at least one segment this workload actually has. */
  applicable: boolean;
  /** Theo applies it to this workload today (it is in leversFor). */
  applied: boolean;
  /**
   * Projected saving from this lever alone on this workload, in USD and as a
   * share of the baseline. For an applied lever this is its marginal saving in
   * Theo's real stack; for an unapplied one it is the standalone projection. Both
   * are hypotheses from the lever's published evidence — never a realised saving.
   */
  projectedSavingUsd: number;
  projectedSavingPercent: number;
  /** Why an applicable lever is not applied. Absent when applied, or not applicable. */
  reason?: string;
};

export type CoverageReport = {
  workload: string;
  baselineCostUsd: number;
  /** Theo's actual stacked projection on this workload (what leversFor delivers). */
  realizedSavingUsd: number;
  realizedSavingPercent: number;
  /** The part of the realized saving that cannot change an answer — live immediately. */
  realizedDeterministicPercent: number;
  /** The part that needs a replay proof within the quality ceiling before it is enabled. */
  realizedNeedsVerificationPercent: number;
  /** Catalogue levers that can touch this workload (N). */
  applicableLevers: number;
  /** Of those, how many Theo applies (M). */
  appliedLevers: number;
  /** M / N as a percentage — the headline coverage figure. */
  leverCoveragePercent: number;
  /** Every catalogue lever, applied or not, sorted by projected headroom descending. */
  levers: LeverCoverage[];
  /** Applicable levers Theo does not apply, each with a reason. Sorted by headroom. */
  gaps: LeverCoverage[];
};

function isApplicable(lever: Lever, profile: WorkloadProfile): boolean {
  return lever.targets.some((segment) => (profile.segments[segment] ?? 0) > 0);
}

/**
 * The lever's own saving on this workload, isolated from caching. projectSavings
 * applies prefix caching after the reducers, so savingUsd for a single lever
 * folds in a caching saving the lever did not cause. The lever's first (and only)
 * contribution is its pure reducer effect, which is what belongs to the lever.
 */
function standaloneSavingUsd(lever: Lever, profile: WorkloadProfile, price: TokenPrice): number {
  const projection = projectSavings(profile, [lever], price);
  return projection.contributions[0]?.costRemovedUsd ?? 0;
}

/**
 * Measure how much of the lever catalogue Theo reaches on one workload profile.
 *
 * Deterministic: the same profile, price and catalogue always produce the same
 * report, so it is safe to diff across builds and to assert on in tests.
 */
export function coverageForProfile(profile: WorkloadProfile, price: TokenPrice): CoverageReport {
  const realized = projectSavings(profile, leversFor(profile), price);
  const appliedIds = new Set(realized.contributions.map((contribution) => contribution.lever));
  // Marginal saving of each applied lever, in the order Theo actually stacks them.
  const marginalById = new Map(realized.contributions.map((c) => [c.lever, c.costRemovedUsd]));

  const baseline = realized.baselineCostUsd;
  const share = (usd: number): number => (baseline === 0 ? 0 : (usd / baseline) * 100);

  const levers: LeverCoverage[] = Object.values(PUBLISHED_LEVERS).map((lever) => {
    const applicable = isApplicable(lever, profile);
    const applied = appliedIds.has(lever.id);
    const savingUsd = applied
      ? marginalById.get(lever.id) ?? 0
      : applicable
        ? standaloneSavingUsd(lever, profile, price)
        : 0;
    let reason: string | undefined;
    if (applicable && !applied) {
      reason =
        ARCHITECTURE_LEVERS[lever.id] ??
        HELD_LEVERS[lever.id] ??
        "Not in Theo's active lever set for this workload.";
    }
    return {
      leverId: lever.id,
      description: lever.description,
      risk: lever.risk,
      applicable,
      applied,
      projectedSavingUsd: savingUsd,
      projectedSavingPercent: share(savingUsd),
      reason,
    };
  });
  levers.sort((a, b) => b.projectedSavingUsd - a.projectedSavingUsd);

  const applicableLevers = levers.filter((l) => l.applicable).length;
  const appliedLevers = levers.filter((l) => l.applied).length;
  const gaps = levers.filter((l) => l.applicable && !l.applied);

  return {
    workload: profile.name,
    baselineCostUsd: baseline,
    realizedSavingUsd: realized.savingUsd,
    realizedSavingPercent: realized.savingPercent,
    realizedDeterministicPercent: realized.deterministicSavingPercent,
    realizedNeedsVerificationPercent: realized.needsVerificationSavingPercent,
    applicableLevers,
    appliedLevers,
    leverCoveragePercent: applicableLevers === 0 ? 100 : (appliedLevers / applicableLevers) * 100,
    levers,
    gaps,
  };
}
