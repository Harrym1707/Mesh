import type { TokenPrice } from "../../core/dist/src/cost.js";
import {
  leversFor,
  projectSavings,
  type LeverContribution,
  type WorkloadProfile,
  type WorkloadSegment,
} from "../../core/dist/src/savings-model.js";
import type { BlindFeatures } from "./blind-features.js";
import {
  defaultPolicy,
  effectiveQualityCeiling,
  policyCoverage,
  publishLever,
  type TheoLeverClass,
  type TheoPolicy,
} from "./theo-policy.js";

/**
 * Theo — the persistent, per-customer token-engineer agent.
 *
 * This is the running loop the R&D sketch (docs/rnd/theo-token-engineer-agent.md)
 * describes, built on primitives that already exist: blind features (Observe),
 * the savings model (Hypothesise), the replay gate (Prove), and the per-user
 * policy the proxy enforces (Decide). The prototype in evals/theo-loop.ts proved
 * the shape offline; this turns it into a stateful agent with memory and a
 * configurable autonomy level.
 *
 * Two invariants hold in code, not by trust:
 *
 *   1. **This module is pure.** It never reads the clock, the disk or the
 *      network, and it never calls a provider. Persistence lives in
 *      `theo-agent-store.ts`; proving a lever lives at the call site (the replay
 *      gate). The cycle CONSUMES proofs it is handed and never invents one.
 *
 *   2. **Theo never enables a saving he has not proven.** Only the three truly
 *      lossless levers run unconditionally (they cannot change the answer). Every
 *      other lever is withheld until a replay-gate proof shows, on the customer's
 *      own traffic, that quality held within the route's ceiling — and even then
 *      Theo only auto-publishes it at the `optimise` autonomy level. The
 *      enforcement point is `publishLever` in theo-policy.ts, which refuses a
 *      lossy lever with no gate proof.
 */

/**
 * How much Theo may do on his own, lowest to highest. This is the "Improve" dial
 * from the product guide:
 *
 *   observe   — identify opportunities, change nothing.
 *   recommend — auto-apply lossless; surface proven lossy levers as proposals.
 *   test      — recommend, and additionally initiate gate experiments (emit the
 *               requests for the next lossy candidates to prove).
 *   optimise  — auto-publish a lossy lever once it has a passing proof within the
 *               route's quality ceiling (pre-approved, reversible).
 */
export type TheoAutonomyLevel = "observe" | "recommend" | "test" | "optimise";

/** A lossy lever Theo believes is worth proving next. The share is a prior for
 * ORDERING only — it is never shown to the customer as a saving. */
export type TheoHypothesis = {
  lever: string;
  class: TheoLeverClass;
  priorSharePercent: number;
  rationale: string;
};

/** An opportunity the savings model sees that the proxy cannot yet enforce as a
 * discrete lever (new reducer code or an app-side change — the parked frontier). */
export type TheoFrontierOpportunity = {
  concept: string;
  priorSharePercent: number;
  note: string;
};

/** One replay-gate outcome, kept so a lever is never re-tested from scratch. */
export type TheoExperiment = {
  lever: string;
  ranAt: string;
  passed: boolean;
  savingPercent?: number;
  qualityDeltaPercent?: number;
  grader?: string;
  note?: string;
};

/** A proven lossy lever awaiting the customer's approval (recommend/test modes). */
export type TheoProposal = {
  lever: string;
  savingPercent: number;
  qualityDeltaPercent: number;
  grader: string;
  provenAt: string;
  message: string;
};

export type TheoCycleLogEntry = {
  at: string;
  autonomy: TheoAutonomyLevel;
  observed: string;
  actions: number;
};

/** Everything Theo remembers about one customer's environment. Persisted as JSON. */
export type TheoMemory = {
  schemaVersion: 1;
  customer: string;
  autonomy: TheoAutonomyLevel;
  /** The live policy the proxy enforces. Theo's only lever on the world. */
  policy: TheoPolicy;
  /** The most recently observed workload shape. */
  profile?: WorkloadProfile;
  /** Ranked lossy candidates not yet active. */
  hypotheses: TheoHypothesis[];
  /** Opportunities beyond the enforceable repertoire. */
  frontier: TheoFrontierOpportunity[];
  /** Append-only log of gate outcomes. */
  experiments: TheoExperiment[];
  /** Open proposals the customer has not yet accepted or rejected. */
  proposals: TheoProposal[];
  /** Per applied lossy lever: the retry and failure rates measured when it was
   * proven, so a later rise in either can be detected as quality drift. */
  driftBaselines: Record<string, { retryRate: number; failureRate: number; at: string }>;
  /** Levers Theo auto-rolled-back after drift; not re-proposed this session. */
  rolledBack: string[];
  log: TheoCycleLogEntry[];
  updatedAt: string;
};

/** What Theo sees this cycle. The profile comes from Observe (blind features);
 * the realised figures come from the ledger and feed the report only. */
export type TheoObservation = {
  profile: WorkloadProfile;
  price: TokenPrice;
  realisedSavingsUsd?: number;
  realisedSpendUsd?: number;
  /** Fraction of recent requests that were retries (duplicate of a prior one) —
   * a behavioural-drift signal. When it rises after a lever is applied, Theo
   * rolls that lever back. Omit it and that signal simply does not fire. */
  retryRate?: number;
  /** Fraction of recent requests that FAILED (provider error) — a second drift
   * signal, caught the same way. Omit it to ignore it. */
  failureRate?: number;
};

/** A measured gate result the caller obtained (from `replayGate`) and hands to
 * the cycle. Theo trusts the measurement; he never produces one himself. */
export type TheoProof = {
  lever: string;
  /** Measured saving on the customer's own traffic, from provider usage. */
  savingPercent: number;
  /** Measured quality delta; its magnitude is compared to the route ceiling. */
  qualityDeltaPercent: number;
  grader: string;
  provenAt: string;
};

export type TheoAction =
  | { kind: "lossless-active"; levers: string[] }
  | { kind: "policy-published"; version: number; lever: string }
  | { kind: "proposal-opened"; lever: string; savingPercent: number; qualityDeltaPercent: number }
  | { kind: "gate-requested"; levers: string[] }
  | { kind: "proof-rejected"; lever: string; reason: string }
  | { kind: "rolled-back"; lever: string; reason: string };

export type TheoCycleResult = {
  memory: TheoMemory;
  actions: TheoAction[];
  report: string;
};

/**
 * Savings-model CONCEPTS that map to a lever the proxy can actually enforce.
 * A concept absent here is a real opportunity Theo still reports, but one that
 * needs new reduction code or an app-side change — he will not pretend he can
 * flip it. Ids on the right must be valid `knownLeverIds()`.
 */
const ENFORCEABLE_BY_CONCEPT: Record<string, { lever: string; class: TheoLeverClass }> = {
  "tool-schema-compaction": { lever: "tool-schema-compaction", class: "lossless" },
  "duplicate-context-removal": { lever: "duplicate-context-removal", class: "lossless" },
  "tool-schema-description-trim": { lever: "tool-schema-description-trim", class: "lossy" },
  "history-compaction": { lever: "stale-history-compaction", class: "lossy" },
  "output-budget": { lever: "output-effort-low", class: "lossy" },
};

/** Concepts already covered by an active lossless lever — neither a candidate nor
 * a frontier gap. `prefix-caching` is delivered by the active cache-prefix-repair. */
const ALREADY_COVERED_CONCEPTS = new Set(["prefix-caching"]);

/**
 * Concepts that HAVE an enforceable lever but that Theo cannot author himself,
 * because filling the lever's parameters needs content he is blind to (e.g. tool
 * names). These stay on the frontier — Theo surfaces the opportunity with the
 * exact operator step to enable it, rather than claiming new code is needed.
 */
const OPERATOR_CONFIGURED_CONCEPTS: Record<string, string> = {
  "unused-tool-removal":
    "An enforceable lever now exists (`unused-tool-removal`). Theo is content-blind and cannot name the tools, " +
    "so enable it with the tool names your workload never calls — the replay gate proves it on your traffic before billing.",
};

/** The lossy enforceable lever ids Theo can prove and adopt. */
const ENFORCEABLE_LOSSY = new Set(
  Object.values(ENFORCEABLE_BY_CONCEPT)
    .filter((entry) => entry.class === "lossy")
    .map((entry) => entry.lever),
);

/** How far the retry rate may rise above an applied lever's baseline before Theo
 * treats it as quality drift and rolls the lever back (absolute fraction).
 * Exported so surfaces (e.g. the dashboard's health panel) flag "watch" against
 * the SAME line Theo actually rolls back on — one source of truth, not a copy. */
export const DRIFT_RISE_THRESHOLD = 0.05;

function zeroSegments(): Record<WorkloadSegment, number> {
  return { toolSchemas: 0, systemPrompt: 0, retrievedContext: 0, history: 0, userTurn: 0, output: 0 };
}

/**
 * OBSERVE — fold blind features into a workload profile. Learned from irreversible
 * features only; no prompt, code or response is ever read. Output tokens are not
 * present in a request, so they are supplied from the ledger (mean per request).
 */
export function observeWorkload(
  features: readonly BlindFeatures[],
  options: { name?: string; outputTokensMean?: number } = {},
): WorkloadProfile {
  const name = options.name ?? "observed";
  const n = features.length;
  if (n === 0) {
    return { name, requests: 1, segments: zeroSegments(), stableSegments: [] };
  }
  const mean = (nums: number[]): number => nums.reduce((sum, value) => sum + value, 0) / nums.length;
  const segments: Record<WorkloadSegment, number> = {
    toolSchemas: mean(features.map((f) => f.toolSchemaTokensApprox)),
    systemPrompt: mean(features.map((f) => f.roleTokensApprox.system ?? 0)),
    retrievedContext: 0,
    history: mean(features.map((f) => (f.roleTokensApprox.assistant ?? 0) + (f.roleTokensApprox.tool ?? 0))),
    userTurn: mean(features.map((f) => f.roleTokensApprox.user ?? 0)),
    output: Math.max(0, options.outputTokensMean ?? 0),
  };
  // A single stable tools+system prefix across turns is the cross-turn cache signal.
  const prefixReuse = n > 1 && new Set(features.map((f) => f.stablePrefixHash)).size === 1;
  const stableSegments: WorkloadSegment[] = prefixReuse ? ["toolSchemas", "systemPrompt"] : [];
  return { name, requests: n, segments, stableSegments };
}

/** A fresh agent for a new customer: strict, lossless-only, nothing proven yet. */
export function createTheoMemory(
  customer: string,
  autonomy: TheoAutonomyLevel,
  at: string,
): TheoMemory {
  return {
    schemaVersion: 1,
    customer,
    autonomy,
    policy: defaultPolicy(customer, at),
    hypotheses: [],
    frontier: [],
    experiments: [],
    proposals: [],
    driftBaselines: {},
    rolledBack: [],
    log: [],
    updatedAt: at,
  };
}

/** The lossless lever ids currently in the policy (always enforced). */
function losslessLevers(policy: TheoPolicy): string[] {
  return policy.levers.filter((lever) => lever.class === "lossless").map((lever) => lever.lever);
}

/** HYPOTHESISE — rank enforceable lossy candidates, and surface frontier gaps. */
function hypothesise(
  profile: WorkloadProfile,
  price: TokenPrice,
  activeLossy: ReadonlySet<string>,
  rolledBack: ReadonlySet<string>,
): { hypotheses: TheoHypothesis[]; frontier: TheoFrontierOpportunity[] } {
  let contributions: LeverContribution[];
  try {
    contributions = projectSavings(profile, leversFor(profile), price).contributions;
  } catch {
    return { hypotheses: [], frontier: [] };
  }
  const ranked = [...contributions].sort((a, b) => b.sharePercent - a.sharePercent);

  const hypotheses: TheoHypothesis[] = [];
  const frontier: TheoFrontierOpportunity[] = [];
  const seen = new Set<string>();
  for (const contribution of ranked) {
    if (contribution.sharePercent <= 0) continue;
    if (ALREADY_COVERED_CONCEPTS.has(contribution.lever)) continue;
    const mapped = ENFORCEABLE_BY_CONCEPT[contribution.lever];
    if (mapped === undefined) {
      frontier.push({
        concept: contribution.lever,
        priorSharePercent: contribution.sharePercent,
        note: OPERATOR_CONFIGURED_CONCEPTS[contribution.lever]
          ?? "Opportunity with no enforceable proxy lever yet — needs new reduction code or an app-side change.",
      });
      continue;
    }
    if (mapped.class === "lossless") continue; // already active in the policy.
    if (rolledBack.has(mapped.lever)) continue; // auto-rolled-back after drift; don't re-propose
    if (activeLossy.has(mapped.lever) || seen.has(mapped.lever)) continue;
    seen.add(mapped.lever);
    hypotheses.push({
      lever: mapped.lever,
      class: "lossy",
      priorSharePercent: contribution.sharePercent,
      rationale: contribution.evidence.claim,
    });
  }
  return { hypotheses, frontier };
}

function proposalMessage(proof: TheoProof): string {
  const drop = Math.abs(proof.qualityDeltaPercent);
  return `${proof.lever}: proven to save ~${proof.savingPercent.toFixed(1)}% on your traffic, ` +
    `measured quality cost ~${drop.toFixed(2)}% (grader: ${proof.grader}). Apply it?`;
}

/**
 * Run one Theo cycle: Observe -> Hypothesise -> (consume) Prove -> Decide -> Report.
 * Pure: returns a new memory, the actions taken, and a human-readable report.
 * `now` is the caller's clock; `input.proofs` are gate results the caller obtained.
 */
export function runTheoCycle(
  memory: TheoMemory,
  input: { observation: TheoObservation; proofs?: readonly TheoProof[] },
  now: string,
): TheoCycleResult {
  const { observation } = input;
  const proofs = input.proofs ?? [];
  const autonomy = memory.autonomy;
  const actions: TheoAction[] = [];

  let policy = memory.policy;
  const experiments = [...memory.experiments];
  const proposals = [...memory.proposals];
  const driftBaselines = { ...(memory.driftBaselines ?? {}) };
  const rolledBack = [...(memory.rolledBack ?? [])];

  // OBSERVE
  const profile = observation.profile;

  // MONITOR — auto-rollback on behavioural drift. If the retry rate OR the
  // failure rate has risen materially since an applied lossy lever was proven,
  // that is a quality regression after rollout (users re-running, or more
  // provider errors): roll the lever back and don't re-propose it. This is the
  // "never degrade" guarantee holding AFTER rollout, not just at the gate.
  const retryRate = observation.retryRate;
  const failureRate = observation.failureRate;
  if (retryRate !== undefined || failureRate !== undefined) {
    const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
    for (const lever of policy.levers) {
      if (lever.class !== "lossy" || lever.gate === undefined) continue;
      const baseline = driftBaselines[lever.lever];
      if (baseline === undefined) continue;
      const retryRose = retryRate !== undefined && retryRate > baseline.retryRate + DRIFT_RISE_THRESHOLD;
      const failRose = failureRate !== undefined && failureRate > (baseline.failureRate ?? 0) + DRIFT_RISE_THRESHOLD;
      if (!retryRose && !failRose) continue;
      const reason = retryRose
        ? `retry rate rose ${pct(baseline.retryRate)} → ${pct(retryRate!)}`
        : `failure rate rose ${pct(baseline.failureRate ?? 0)} → ${pct(failureRate!)}`;
      policy = {
        ...policy,
        levers: policy.levers.filter((other) => other.lever !== lever.lever),
        version: policy.version + 1,
        updatedAt: now,
      };
      delete driftBaselines[lever.lever];
      if (!rolledBack.includes(lever.lever)) rolledBack.push(lever.lever);
      experiments.push({ lever: lever.lever, ranAt: now, passed: false, note: `rolled back: ${reason}` });
      actions.push({ kind: "rolled-back", lever: lever.lever, reason });
    }
  }

  // HYPOTHESISE
  const activeLossy = new Set(
    policy.levers.filter((lever) => lever.class === "lossy" && lever.gate !== undefined).map((l) => l.lever),
  );
  const { hypotheses, frontier } = hypothesise(profile, observation.price, activeLossy, new Set(rolledBack));

  // Report lossless coverage (always on; it is the day-0 default).
  const lossless = losslessLevers(policy);
  if (autonomy !== "observe") actions.push({ kind: "lossless-active", levers: lossless });

  // PROVE (consume) + DECIDE
  for (const proof of proofs) {
    if (!ENFORCEABLE_LOSSY.has(proof.lever)) {
      actions.push({ kind: "proof-rejected", lever: proof.lever, reason: "not an enforceable lossy lever" });
      continue;
    }
    if (rolledBack.includes(proof.lever)) {
      actions.push({ kind: "proof-rejected", lever: proof.lever, reason: "auto-rolled-back earlier after quality drift" });
      continue;
    }
    const ceiling = effectiveQualityCeiling(policy.qualityCeilingPercent);
    const withinCeiling = Math.abs(proof.qualityDeltaPercent) <= ceiling;
    const saves = proof.savingPercent > 0;
    const passed = withinCeiling && saves;
    experiments.push({
      lever: proof.lever,
      ranAt: proof.provenAt,
      passed,
      savingPercent: proof.savingPercent,
      qualityDeltaPercent: proof.qualityDeltaPercent,
      grader: proof.grader,
      ...(passed ? {} : {
        note: !saves
          ? "no saving once priced, so nothing to enable"
          : `quality drop ${Math.abs(proof.qualityDeltaPercent).toFixed(2)}% exceeds the ` +
            `${ceiling}% ceiling`,
      }),
    });
    if (!passed) {
      actions.push({
        kind: "proof-rejected",
        lever: proof.lever,
        reason: saves ? "quality drop exceeds the route ceiling" : "no verified saving",
      });
      continue;
    }
    if (autonomy === "optimise") {
      policy = publishLever(
        policy,
        {
          lever: proof.lever,
          class: "lossy",
          gate: {
            savingPercent: proof.savingPercent,
            qualityDeltaPercent: proof.qualityDeltaPercent,
            grader: proof.grader,
            provenAt: proof.provenAt,
          },
        },
        now,
      );
      actions.push({ kind: "policy-published", version: policy.version, lever: proof.lever });
      // Record the drift baselines so a later rise in either can roll it back.
      driftBaselines[proof.lever] = {
        retryRate: observation.retryRate ?? 0,
        failureRate: observation.failureRate ?? 0,
        at: now,
      };
    } else if (autonomy === "recommend" || autonomy === "test") {
      if (!proposals.some((existing) => existing.lever === proof.lever)) {
        proposals.push({
          lever: proof.lever,
          savingPercent: proof.savingPercent,
          qualityDeltaPercent: proof.qualityDeltaPercent,
          grader: proof.grader,
          provenAt: proof.provenAt,
          message: proposalMessage(proof),
        });
        actions.push({
          kind: "proposal-opened",
          lever: proof.lever,
          savingPercent: proof.savingPercent,
          qualityDeltaPercent: proof.qualityDeltaPercent,
        });
      }
    }
    // observe: the experiment is recorded; no proposal, no publish.
  }

  // Candidates that still need a proof are the ones a proof just settled removed.
  const provenThisCycle = new Set(proofs.map((proof) => proof.lever));
  const openHypotheses = hypotheses.filter((hypothesis) => !provenThisCycle.has(hypothesis.lever));

  // Theo initiates experiments from `test` upward: emit the next levers to prove.
  if ((autonomy === "test" || autonomy === "optimise") && openHypotheses.length > 0) {
    actions.push({ kind: "gate-requested", levers: openHypotheses.slice(0, 3).map((h) => h.lever) });
  }

  const nextMemory: TheoMemory = {
    ...memory,
    policy,
    profile,
    hypotheses: openHypotheses,
    frontier,
    experiments,
    proposals,
    driftBaselines,
    rolledBack,
    log: [
      ...memory.log,
      {
        at: now,
        autonomy,
        observed: `${profile.name}: ${profile.requests} req, ${Math.round(sumSegments(profile))} tok/req`,
        actions: actions.length,
      },
    ],
    updatedAt: now,
  };

  return { memory: nextMemory, actions, report: renderTheoReport(nextMemory, observation, actions) };
}

function sumSegments(profile: WorkloadProfile): number {
  return Object.values(profile.segments).reduce((sum, value) => sum + value, 0);
}

/** A short, honest status line set for the customer — no unproven numbers. */
export function renderTheoReport(
  memory: TheoMemory,
  observation: TheoObservation,
  actions: readonly TheoAction[],
): string {
  const coverage = policyCoverage(memory.policy);
  const published = actions.filter((a) => a.kind === "policy-published").length;
  const proposed = memory.proposals.length;
  const lines: string[] = [];
  lines.push(`Theo — ${memory.customer} (autonomy: ${memory.autonomy})`);
  lines.push(
    `OBSERVE: ${observation.profile.name}, ${observation.profile.requests} requests, ` +
    `${Math.round(sumSegments(observation.profile))} tok/req (from blind features only).`,
  );
  lines.push(
    `ACTIVE: ${coverage.activeCount}/${coverage.enforceableCount} enforceable levers ` +
    `(${coverage.activeCoveragePercent.toFixed(0)}%), lossless on by default.`,
  );
  if (memory.hypotheses.length > 0) {
    lines.push(`QUEUE: ${memory.hypotheses.length} lossy candidate(s) ranked to prove (priors, not claims).`);
  }
  if (memory.frontier.length > 0) {
    lines.push(`FRONTIER: ${memory.frontier.length} opportunity(ies) needing new code — reported, not touched.`);
  }
  if (published > 0) lines.push(`APPLIED: ${published} proven lever(s) published to the policy this cycle.`);
  const rolledBackNow = actions.filter((a) => a.kind === "rolled-back").length;
  if (rolledBackNow > 0) lines.push(`ROLLED BACK: ${rolledBackNow} lever(s) reverted after a retry-rate rise (quality drift).`);
  if (proposed > 0) lines.push(`PROPOSED: ${proposed} proven lever(s) awaiting your approval.`);
  if (observation.realisedSavingsUsd !== undefined) {
    lines.push(`LEDGER: $${observation.realisedSavingsUsd.toFixed(2)} verified savings recorded so far.`);
  }
  lines.push("Theo never enables a saving he has not proven on your own traffic within your quality ceiling.");
  return lines.join("\n");
}
