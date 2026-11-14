// The consumer AI workload mix, and the fleet "% saved for the end user" —
// the metric the lab and the continuous team are judged on.
//
// The lab proves a lever on a fixture; this module rolls those measured wins up
// into a single blended number across the real mix of what people use AI for.
// It is deliberately honest about where Mesh does NOT yet save:
//   - the output / reasoning side of agents, where the runnable levers are
//     lossless input-side reductions and the output levers are still gated; and
//   - image / video generation, PARKED by founder decision
//     (docs/rnd/2026-11-07-image-video-PARKED-decision.md) — per-generation
//     pricing that a token lever cannot reduce, advisory-only if ever touched.
//
// The spend weights are an ESTIMATE / illustrative default, not measured — real
// weights come from a customer's own blind telemetry. They are configurable.

import type { LabLedger } from "./ledger.js";

export type WorkloadDomain =
  | "chat"
  | "coding-agent"
  | "autonomous-agent"
  | "always-on-agent"
  | "rag"
  | "one-shot"
  | "reasoning"
  | "image-gen"
  | "video-gen";

export type Addressability = "token-billed" | "parked-advisory-only";

export type WorkloadProfile = {
  domain: WorkloadDomain;
  label: string;
  /** Illustrative share of consumer AI spend (ESTIMATE, sums to 1). */
  spendShare: number;
  addressable: Addressability;
  /** Fixtures whose measured lever savings represent this workload (best wins). */
  fixtureIds?: string[];
  note?: string;
};

/**
 * Illustrative consumer mix (basis: ESTIMATE). Weights are a placeholder for a
 * customer's measured telemetry, not a claim. They sum to 1.
 */
export const CONSUMER_WORKLOAD_MIX: WorkloadProfile[] = [
  // Cache is credited ONLY on the human-paced, prefix-stable shapes where Mesh's
  // cadence-aware TTL genuinely adds caching the customer loses to 5m expiry
  // (chat, always-on). Tight-loop coding/autonomous agents already cache and
  // churn context, so they are NOT credited the prefix-cache — only their
  // dedup / tool-schema / stack savings count (do-not-pay-us on cache-hot shapes).
  { domain: "chat", label: "Conversational chat", spendShare: 0.3, addressable: "token-billed", fixtureIds: ["chat-conversation", "chat-session"] },
  { domain: "coding-agent", label: "Coding assistants / agents", spendShare: 0.2, addressable: "token-billed", fixtureIds: ["coding-agent"] },
  { domain: "autonomous-agent", label: "Autonomous tool agents", spendShare: 0.1, addressable: "token-billed", fixtureIds: ["agent-tool-schemas", "coding-agent"] },
  { domain: "always-on-agent", label: "Always-on agents / monitors", spendShare: 0.08, addressable: "token-billed", fixtureIds: ["agent-history-resend", "agent-session"] },
  { domain: "rag", label: "RAG / document Q&A", spendShare: 0.12, addressable: "token-billed", fixtureIds: ["rag-duplicate-passages"] },
  { domain: "one-shot", label: "One-shot generate / extract / classify", spendShare: 0.08, addressable: "token-billed", fixtureIds: ["padded-whitespace"] },
  {
    domain: "reasoning",
    label: "Reasoning / thinking-token heavy",
    spendShare: 0.07,
    addressable: "token-billed",
    note: "Output/reasoning-side spend. The runnable levers are lossless input-side reductions; output levers (effort governor, re-emission) are gated and still INCONCLUSIVE — this is the frontier.",
  },
  {
    domain: "image-gen",
    label: "Image generation",
    spendShare: 0.03,
    addressable: "parked-advisory-only",
    note: "PARKED: per-image pricing, not per-token. Advisory only; never an auto-billed token saving.",
  },
  {
    domain: "video-gen",
    label: "Video generation",
    spendShare: 0.02,
    addressable: "parked-advisory-only",
    note: "PARKED: per-second pricing, not per-token. Advisory only.",
  },
];

export type WorkloadSaving = {
  domain: WorkloadDomain;
  label: string;
  spendShare: number;
  addressable: Addressability;
  /** Best measured lossless token reduction a promoted lever gives this shape. */
  savingsPercent: number;
  bestLeverId?: string;
  note?: string;
};

export type FleetSavings = {
  workloads: WorkloadSaving[];
  /** Blended % saved for the end user across the whole mix (parked contribute 0). */
  fleetPercentSaved: number;
  /** Share of spend Mesh can address with token levers. */
  addressableShare: number;
  parkedShare: number;
};

/**
 * Roll the promoted portfolio up into the fleet number. For each workload, the
 * savings is the best measured token reduction among promoted levers proven on
 * that workload's fixture (0 where none is proven yet).
 */
export function fleetSavings(
  ledger: LabLedger,
  mix: WorkloadProfile[] = CONSUMER_WORKLOAD_MIX,
): FleetSavings {
  const promoted = ledger.listRecords({ status: "promoted" });

  const workloads: WorkloadSaving[] = mix.map((profile) => {
    let savingsPercent = 0;
    let bestLeverId: string | undefined;
    const fixtures = profile.fixtureIds ?? [];
    if (profile.addressable === "token-billed" && fixtures.length > 0) {
      for (const record of promoted) {
        if (!record.spec?.datasetFixtureId || !fixtures.includes(record.spec.datasetFixtureId)) continue;
        const pct = record.evaluation?.tokenReductionPercent ?? 0;
        if (pct > savingsPercent) {
          savingsPercent = pct;
          bestLeverId = record.id;
        }
      }
    }
    return {
      domain: profile.domain,
      label: profile.label,
      spendShare: profile.spendShare,
      addressable: profile.addressable,
      savingsPercent,
      bestLeverId,
      note: profile.note,
    };
  });

  const fleetPercentSaved = workloads.reduce(
    (sum, w) => sum + w.spendShare * (w.savingsPercent / 100),
    0,
  ) * 100;
  const addressableShare = mix
    .filter((w) => w.addressable === "token-billed")
    .reduce((s, w) => s + w.spendShare, 0);

  return {
    workloads,
    fleetPercentSaved,
    addressableShare,
    parkedShare: 1 - addressableShare,
  };
}
