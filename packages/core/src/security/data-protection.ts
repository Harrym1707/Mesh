/**
 * Encryption configuration and retention controls — the data-governance
 * posture made explicit, validated, and testable.
 *
 * The roadmap lists "encryption", "retention controls", and "data residency".
 * Enforcing them is an infrastructure property (KMS, region-pinned stores; see
 * the hardening plan, bucket B). What belongs IN the repo is the part that is
 * logic, not infra:
 *
 *   - a declarative config that says what the posture IS, validated so an
 *     impossible or unsafe config (a disallowed cipher, a negative retention
 *     window) is rejected at the boundary rather than deployed; and
 *   - the pure decision a retention job runs: given a retention policy and a
 *     set of dated records, which records are past their window and must be
 *     purged. That decision is the same whatever store it runs against, so it
 *     is unit-testable here with zero infrastructure.
 *
 * Nothing here encrypts or deletes anything. It describes and decides; the
 * data plane acts.
 */

/** The data classes MESH stores, from `02_TECHNICAL_ARCHITECTURE.md` §8–9. */
export type DataClass =
  | "inference_events"
  | "token_usage"
  | "quality_measurements"
  | "audit_log"
  | "evaluation_datasets"
  | "traces";

/**
 * Symmetric ciphers MESH will accept for data at rest. Deny anything else.
 * AEAD-only: non-authenticated modes (e.g. AES-256-CBC) are excluded because
 * they provide confidentiality without integrity and are a recurring source of
 * padding-oracle and bit-flipping attacks — not acceptable for an at-rest
 * posture an enterprise review will scrutinise.
 */
const ALLOWED_AT_REST_ALGORITHMS = ["AES-256-GCM", "ChaCha20-Poly1305"] as const;
export type AtRestAlgorithm = (typeof ALLOWED_AT_REST_ALGORITHMS)[number];

/** Minimum TLS version accepted for data in transit. */
export type TlsVersion = "TLS1.2" | "TLS1.3";

export type EncryptionConfig = {
  atRest: {
    enabled: boolean;
    algorithm: AtRestAlgorithm;
    /**
     * Reference to the key in the customer's/our KMS — e.g. an ARN or key id.
     * A REFERENCE only: never the key material, never a secret (see
     * SECURITY.md — the ledger and config record identifiers, never secrets).
     */
    keyRef: string;
  };
  inTransit: {
    minTlsVersion: TlsVersion;
  };
};

/**
 * Retention window for one data class. `retentionDays` is how long a record is
 * kept; `legalHold` pins records so they are never purged regardless of age
 * (the compliance override a retention job must honour).
 */
export type RetentionRule = {
  dataClass: DataClass;
  retentionDays: number;
  legalHold?: boolean;
};

/**
 * The full data-protection policy. `residencyRegion` expresses WHERE data must
 * live (e.g. "eu-west-1"); enforcing it is infra (bucket B), but carrying it
 * here means a residency requirement is a validated part of the policy rather
 * than an afterthought.
 */
export type DataProtectionPolicy = {
  encryption: EncryptionConfig;
  retention: readonly RetentionRule[];
  /** ISO region id data must be pinned to; omit for no residency constraint. */
  residencyRegion?: string;
};

export type ValidationIssue = { field: string; reason: string };

/**
 * Validate a policy, returning every problem at once (not just the first) so a
 * config can be fixed in one pass. An empty array means the policy is
 * well-formed. This is where an unsafe config is caught before deployment.
 */
export function validateDataProtectionPolicy(policy: DataProtectionPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const { atRest, inTransit } = policy.encryption;
  if (atRest.enabled) {
    if (!ALLOWED_AT_REST_ALGORITHMS.includes(atRest.algorithm)) {
      issues.push({
        field: "encryption.atRest.algorithm",
        reason: `Algorithm ${JSON.stringify(atRest.algorithm)} is not in the allow-list [${ALLOWED_AT_REST_ALGORITHMS.join(", ")}].`,
      });
    }
    if (typeof atRest.keyRef !== "string" || atRest.keyRef.trim() === "") {
      issues.push({ field: "encryption.atRest.keyRef", reason: "Encryption at rest is enabled but no key reference is set." });
    }
  }
  if (inTransit.minTlsVersion !== "TLS1.2" && inTransit.minTlsVersion !== "TLS1.3") {
    issues.push({ field: "encryption.inTransit.minTlsVersion", reason: "minTlsVersion must be TLS1.2 or TLS1.3." });
  }

  const seen = new Set<DataClass>();
  for (const rule of policy.retention) {
    if (seen.has(rule.dataClass)) {
      issues.push({ field: `retention.${rule.dataClass}`, reason: "Duplicate retention rule for this data class." });
    }
    seen.add(rule.dataClass);
    if (!Number.isInteger(rule.retentionDays) || rule.retentionDays <= 0) {
      issues.push({ field: `retention.${rule.dataClass}.retentionDays`, reason: "retentionDays must be a positive integer." });
    }
  }

  // The audit log is the evidence trail; refuse to let it be configured for a
  // shorter window than the rest. SOC 2 observation windows run months, and a
  // retention policy that quietly expires the audit log first is a footgun.
  const auditRule = policy.retention.find((r) => r.dataClass === "audit_log");
  if (auditRule !== undefined) {
    const otherMax = policy.retention
      .filter((r) => r.dataClass !== "audit_log")
      .reduce((max, r) => Math.max(max, r.retentionDays), 0);
    if (auditRule.retentionDays < otherMax) {
      issues.push({
        field: "retention.audit_log.retentionDays",
        reason: `The audit log (${auditRule.retentionDays}d) must be retained at least as long as every other class (max ${otherMax}d).`,
      });
    }
  }

  if (policy.residencyRegion !== undefined && policy.residencyRegion.trim() === "") {
    issues.push({ field: "residencyRegion", reason: "residencyRegion, when set, must be a non-empty region id." });
  }

  return issues;
}

export type DatedRecord = {
  id: string;
  dataClass: DataClass;
  /** ISO-8601 instant the record was created. */
  createdAt: string;
};

/**
 * The decision a retention job runs: which records are past their window as of
 * `now`. Pure and total:
 *
 *   - A record whose data class has no retention rule is KEPT (fail-safe: an
 *     unconfigured class is never purged by accident).
 *   - A record under legal hold is KEPT regardless of age.
 *   - A record is purgeable only when `now - createdAt >= retentionDays`.
 *
 * Returns the records to purge; the caller deletes them from the actual store
 * (and SHOULD write a `data.purge` audit event — see `audit-log.ts`).
 */
export function recordsToPurge(
  policy: DataProtectionPolicy,
  records: readonly DatedRecord[],
  now: Date,
): DatedRecord[] {
  const nowMs = now.getTime();
  const ruleByClass = new Map<DataClass, RetentionRule>();
  for (const rule of policy.retention) ruleByClass.set(rule.dataClass, rule);
  const dayMs = 24 * 60 * 60 * 1000;

  return records.filter((record) => {
    const rule = ruleByClass.get(record.dataClass);
    if (rule === undefined) return false; // unconfigured class: keep
    if (rule.legalHold) return false; // legal hold: keep
    const ageMs = nowMs - Date.parse(record.createdAt);
    return ageMs >= rule.retentionDays * dayMs;
  });
}
