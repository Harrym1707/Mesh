import {
  appendToChain,
  chainRecord,
  verifyChain,
  type ChainRecord,
  type ChainVerification,
} from "./hash-chain.js";

/**
 * Immutable rollout history — the append-only, hash-chained record of every
 * rollout state transition for a policy (roadmap: "immutable rollout history").
 *
 * A rollout is the gradual exposure of a candidate model to traffic: enabled
 * at 0%, raised to 5/25/50/100%, paused, or rolled back to baseline. Which of
 * those was live at a given instant — and who made each change, against which
 * signed policy version — is exactly the question an incident review and a
 * SOC 2 auditor ask. Keeping it in a hash chain (shared with the audit log via
 * `hash-chain.ts`) makes it tamper-evident: the history cannot be quietly
 * rewritten to hide a bad rollout.
 *
 * The chain is the source of truth; `currentRolloutState` REDUCES it to the
 * live state. There is no mutable "current percentage" to drift out of sync
 * with the log — the log IS the state.
 */

export type RolloutTransitionKind =
  /** First activation of a policy's rollout (usually at 0%). */
  | "enable"
  /** Change the exposed percentage. */
  | "set_percentage"
  /** Pause exposure without rolling back (percentage held, traffic gated off). */
  | "pause"
  /** Resume a paused rollout. */
  | "resume"
  /** Return all traffic to baseline; the rollout is over. */
  | "rollback";

export type RolloutTransition = {
  schemaVersion: 1;
  /** The policy whose rollout this transitions. */
  policyId: string;
  /** The signed policy version this rollout exposes (digest from `policy-signing`). */
  policyDigest: string;
  tenantId: string;
  applicationId?: string;
  kind: RolloutTransitionKind;
  /** Target exposure 0–100. Required for enable/set_percentage; ignored otherwise. */
  percentage?: number;
  /** Who made the change (user id or "system"). */
  actor: string;
  /** ISO-8601 instant of the transition. */
  timestamp: string;
  /** Why — e.g. "quality regression on turn 4"; non-sensitive. */
  reason?: string;
};

export type RolloutRecord = ChainRecord<RolloutTransition>;

function validateTransition(t: RolloutTransition): void {
  if (t.schemaVersion !== 1) {
    throw new Error(`Unsupported rollout transition schemaVersion ${JSON.stringify(t.schemaVersion)}.`);
  }
  if (typeof t.tenantId !== "string" || t.tenantId === "") {
    throw new Error("Rollout transitions must be tenant-scoped: tenantId is required.");
  }
  if (typeof t.policyId !== "string" || t.policyId === "") {
    throw new Error("Rollout transitions must name a policyId.");
  }
  if (typeof t.policyDigest !== "string" || t.policyDigest === "") {
    throw new Error("Rollout transitions must cite the signed policyDigest they expose.");
  }
  if (typeof t.actor !== "string" || t.actor === "") {
    throw new Error("Rollout transitions must name an actor.");
  }
  if (typeof t.timestamp !== "string" || !Number.isFinite(Date.parse(t.timestamp))) {
    throw new Error("Rollout transitions must carry a valid ISO-8601 timestamp.");
  }
  if (t.kind === "enable" || t.kind === "set_percentage") {
    if (typeof t.percentage !== "number" || !Number.isFinite(t.percentage) || t.percentage < 0 || t.percentage > 100) {
      throw new Error(`A ${t.kind} transition needs a percentage between 0 and 100.`);
    }
  }
}

/** Begin a policy's rollout history with its first transition (usually an `enable`). */
export function startRolloutHistory(transition: RolloutTransition): RolloutRecord {
  validateTransition(transition);
  return chainRecord(transition);
}

/** Append one transition, returning a NEW chain. The input is never mutated. */
export function appendRolloutTransition(
  records: readonly RolloutRecord[],
  transition: RolloutTransition,
): RolloutRecord[] {
  validateTransition(transition);
  return appendToChain(records, transition);
}

/** Verify a rollout history end to end; a break is reported with its exact seq. */
export function verifyRolloutHistory(records: readonly RolloutRecord[]): ChainVerification {
  return verifyChain(records);
}

export type RolloutHistoryState = {
  policyId: string;
  /** Digest currently exposed (from the latest transition that set one). */
  policyDigest: string;
  /** The percentage held by the last enable/set_percentage. */
  percentage: number;
  /** Live status, derived from the last transition's kind. */
  status: "active" | "paused" | "rolled_back";
  /** Effective exposure: 0 while paused or rolled back, else `percentage`. */
  effectivePercentage: number;
  lastActor: string;
  lastTimestamp: string;
};

/**
 * Reduce a rollout history to its current state. The records must already be
 * verified (`verifyRolloutHistory`) and in chain order. A rollback or pause
 * holds the stored percentage but drops the EFFECTIVE exposure to 0, so a
 * reader never has to interpret status and percentage together to know how
 * much traffic is actually exposed.
 *
 * Returns undefined for an empty history (no rollout has begun).
 */
export function currentRolloutState(records: readonly RolloutRecord[]): RolloutHistoryState | undefined {
  if (records.length === 0) return undefined;
  let percentage = 0;
  let policyDigest = "";
  let status: RolloutHistoryState["status"] = "active";
  const first = records[0]!.entry;

  for (const record of records) {
    const t = record.entry;
    policyDigest = t.policyDigest;
    switch (t.kind) {
      case "enable":
      case "set_percentage":
        percentage = t.percentage!;
        status = "active";
        break;
      case "pause":
        status = "paused";
        break;
      case "resume":
        status = "active";
        break;
      case "rollback":
        status = "rolled_back";
        break;
    }
  }

  const last = records[records.length - 1]!.entry;
  return {
    policyId: first.policyId,
    policyDigest,
    percentage,
    status,
    effectivePercentage: status === "active" ? percentage : 0,
    lastActor: last.actor,
    lastTimestamp: last.timestamp,
  };
}
