import {
  appendToChain,
  chainRecord,
  verifyChain,
  type ChainRecord,
  type ChainVerification,
} from "./hash-chain.js";

/**
 * The audit log: immutable, hash-chained events for every production decision,
 * as required by `02_TECHNICAL_ARCHITECTURE.md` §10 ("immutable audit events
 * for production decisions").
 *
 * This is the evidence surface an enterprise security review and a SOC 2
 * engagement ask for first: a tamper-evident record of who did what, to which
 * tenant/application/policy, and whether it succeeded. It reuses the savings
 * ledger's chaining approach (`hash-chain.ts`), so the same "recompute it
 * yourself, and the exact break point is named" guarantee that backs MESH's
 * billing also backs its audit trail.
 *
 * What this module is NOT: it does not persist anything. It is the pure shape
 * and the pure append/verify logic. The store (Postgres per §8) appends with
 * `appendAuditEvent` and persists the returned chain; a reader verifies a spool
 * with `verifyAuditLog`. Keeping it pure is what makes it testable and what
 * lets a customer re-verify an exported log without MESH.
 */

/** The production decisions worth an immutable record. Extend as new decisions appear. */
export type AuditAction =
  | "policy.publish"
  | "policy.sign"
  | "policy.disable"
  | "rollout.change"
  | "rollout.rollback"
  | "access.grant"
  | "access.revoke"
  | "data.export"
  | "data.purge"
  | "config.change";

export type AuditOutcome = "succeeded" | "denied" | "failed";

/**
 * One audit event. Every event is tenant-scoped (§10: enforce `tenantId`,
 * `applicationId`, `policyId` at every boundary); `applicationId` and
 * `policyId` are optional because some decisions are tenant-wide (an access
 * grant) rather than scoped to one application or policy.
 */
export type AuditEvent = {
  schemaVersion: 1;
  /** ISO-8601 instant the decision was made. */
  timestamp: string;
  tenantId: string;
  applicationId?: string;
  policyId?: string;
  /** Who made the decision: a user id, a service account, or "system". */
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  /** The thing acted on, e.g. a policy version id or a role assignment id. */
  target?: string;
  /**
   * Digest of the signed artifact this decision cites, when it has one — e.g.
   * the `policy-signing` digest of the policy version that was published. Lets
   * an auditor tie an audit event to the exact signed object it refers to.
   */
  signedDigest?: string;
  /** Free-form, non-sensitive context. Never prompts, keys, or PII (see SECURITY.md). */
  metadata?: Record<string, string | number | boolean>;
};

export type AuditRecord = ChainRecord<AuditEvent>;

function validateEvent(event: AuditEvent): void {
  if (event.schemaVersion !== 1) {
    throw new Error(`Unsupported audit event schemaVersion ${JSON.stringify(event.schemaVersion)}.`);
  }
  if (typeof event.tenantId !== "string" || event.tenantId === "") {
    throw new Error("Audit events must be tenant-scoped: tenantId is required and non-empty.");
  }
  if (typeof event.actor !== "string" || event.actor === "") {
    throw new Error("Audit events must name an actor.");
  }
  if (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp))) {
    throw new Error("Audit events must carry a valid ISO-8601 timestamp.");
  }
}

/** Build the genesis record of a new audit log. */
export function startAuditLog(event: AuditEvent): AuditRecord {
  validateEvent(event);
  return chainRecord(event);
}

/**
 * Append one event to an existing audit log, returning a NEW chain. The input
 * is never mutated — the log is append-only, and an appended record can only
 * extend the chain, never rewrite a prior one without breaking verification.
 */
export function appendAuditEvent(records: readonly AuditRecord[], event: AuditEvent): AuditRecord[] {
  validateEvent(event);
  return appendToChain(records, event);
}

/** Verify an audit log end to end; a break is reported with its exact seq. */
export function verifyAuditLog(records: readonly AuditRecord[]): ChainVerification {
  return verifyChain(records);
}

/**
 * Read-side filter over a verified log. Does NOT verify — callers verify once
 * with `verifyAuditLog`, then query. Returns records (not bare events) so the
 * caller keeps the chain position of each hit.
 */
export function filterAuditLog(
  records: readonly AuditRecord[],
  filter: {
    tenantId?: string;
    applicationId?: string;
    policyId?: string;
    actor?: string;
    action?: AuditAction;
    outcome?: AuditOutcome;
    /** Inclusive ISO-8601 lower bound. */
    since?: string;
    /** Exclusive ISO-8601 upper bound. */
    until?: string;
  },
): AuditRecord[] {
  const sinceMs = filter.since === undefined ? undefined : Date.parse(filter.since);
  const untilMs = filter.until === undefined ? undefined : Date.parse(filter.until);
  return records.filter((record) => {
    const e = record.entry;
    if (filter.tenantId !== undefined && e.tenantId !== filter.tenantId) return false;
    if (filter.applicationId !== undefined && e.applicationId !== filter.applicationId) return false;
    if (filter.policyId !== undefined && e.policyId !== filter.policyId) return false;
    if (filter.actor !== undefined && e.actor !== filter.actor) return false;
    if (filter.action !== undefined && e.action !== filter.action) return false;
    if (filter.outcome !== undefined && e.outcome !== filter.outcome) return false;
    const atMs = Date.parse(e.timestamp);
    if (sinceMs !== undefined && atMs < sinceMs) return false;
    if (untilMs !== undefined && atMs >= untilMs) return false;
    return true;
  });
}
