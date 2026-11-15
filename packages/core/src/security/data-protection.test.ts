import { describe, expect, it } from "vitest";
import {
  recordsToPurge,
  validateDataProtectionPolicy,
  type DataProtectionPolicy,
  type DatedRecord,
} from "./data-protection.js";

function policy(overrides: Partial<DataProtectionPolicy> = {}): DataProtectionPolicy {
  return {
    encryption: {
      atRest: { enabled: true, algorithm: "AES-256-GCM", keyRef: "arn:aws:kms:eu-west-1:…:key/abc" },
      inTransit: { minTlsVersion: "TLS1.2" },
    },
    retention: [
      { dataClass: "inference_events", retentionDays: 90 },
      { dataClass: "audit_log", retentionDays: 365 },
    ],
    ...overrides,
  };
}

describe("validateDataProtectionPolicy", () => {
  it("accepts a well-formed policy", () => {
    expect(validateDataProtectionPolicy(policy())).toEqual([]);
  });

  it("rejects a disallowed at-rest algorithm", () => {
    const issues = validateDataProtectionPolicy(policy({
      encryption: {
        atRest: { enabled: true, algorithm: "DES" as never, keyRef: "k" },
        inTransit: { minTlsVersion: "TLS1.3" },
      },
    }));
    expect(issues.some((i) => i.field === "encryption.atRest.algorithm")).toBe(true);
  });

  it("rejects AES-256-CBC: at-rest ciphers are AEAD-only", () => {
    const issues = validateDataProtectionPolicy(policy({
      encryption: {
        atRest: { enabled: true, algorithm: "AES-256-CBC" as never, keyRef: "k" },
        inTransit: { minTlsVersion: "TLS1.3" },
      },
    }));
    expect(issues.some((i) => i.field === "encryption.atRest.algorithm")).toBe(true);
  });

  it("accepts ChaCha20-Poly1305 (also AEAD)", () => {
    const issues = validateDataProtectionPolicy(policy({
      encryption: {
        atRest: { enabled: true, algorithm: "ChaCha20-Poly1305", keyRef: "k" },
        inTransit: { minTlsVersion: "TLS1.3" },
      },
    }));
    expect(issues).toEqual([]);
  });

  it("requires a key reference when at-rest encryption is enabled", () => {
    const issues = validateDataProtectionPolicy(policy({
      encryption: {
        atRest: { enabled: true, algorithm: "AES-256-GCM", keyRef: "  " },
        inTransit: { minTlsVersion: "TLS1.2" },
      },
    }));
    expect(issues).toContainEqual({
      field: "encryption.atRest.keyRef",
      reason: "Encryption at rest is enabled but no key reference is set.",
    });
  });

  it("does not require a key when at-rest encryption is disabled", () => {
    const issues = validateDataProtectionPolicy(policy({
      encryption: {
        atRest: { enabled: false, algorithm: "AES-256-GCM", keyRef: "" },
        inTransit: { minTlsVersion: "TLS1.2" },
      },
    }));
    expect(issues).toEqual([]);
  });

  it("rejects non-positive and non-integer retention windows", () => {
    const issues = validateDataProtectionPolicy(policy({
      retention: [
        { dataClass: "inference_events", retentionDays: 0 },
        { dataClass: "token_usage", retentionDays: 30.5 },
        { dataClass: "audit_log", retentionDays: 365 },
      ],
    }));
    expect(issues.filter((i) => i.reason === "retentionDays must be a positive integer.")).toHaveLength(2);
  });

  it("flags duplicate retention rules for the same data class", () => {
    const issues = validateDataProtectionPolicy(policy({
      retention: [
        { dataClass: "inference_events", retentionDays: 90 },
        { dataClass: "inference_events", retentionDays: 30 },
        { dataClass: "audit_log", retentionDays: 365 },
      ],
    }));
    expect(issues.some((i) => i.reason === "Duplicate retention rule for this data class.")).toBe(true);
  });

  it("refuses an audit log retained for less than another data class", () => {
    const issues = validateDataProtectionPolicy(policy({
      retention: [
        { dataClass: "inference_events", retentionDays: 400 },
        { dataClass: "audit_log", retentionDays: 365 },
      ],
    }));
    expect(issues.some((i) => i.field === "retention.audit_log.retentionDays")).toBe(true);
  });

  it("reports every issue at once", () => {
    const issues = validateDataProtectionPolicy({
      encryption: {
        atRest: { enabled: true, algorithm: "DES" as never, keyRef: "" },
        inTransit: { minTlsVersion: "SSL3" as never },
      },
      retention: [{ dataClass: "inference_events", retentionDays: -1 }],
      residencyRegion: "   ",
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it("accepts a valid residency region and rejects an empty one", () => {
    expect(validateDataProtectionPolicy(policy({ residencyRegion: "eu-west-1" }))).toEqual([]);
    expect(validateDataProtectionPolicy(policy({ residencyRegion: "" })).some((i) => i.field === "residencyRegion")).toBe(true);
  });
});

describe("recordsToPurge", () => {
  const now = new Date("2026-11-07T00:00:00.000Z");
  const records: DatedRecord[] = [
    { id: "old-event", dataClass: "inference_events", createdAt: "2026-07-01T00:00:00.000Z" }, // 129d old > 90d
    { id: "fresh-event", dataClass: "inference_events", createdAt: "2026-10-20T00:00:00.000Z" }, // 18d old < 90d
    { id: "old-audit", dataClass: "audit_log", createdAt: "2025-01-01T00:00:00.000Z" }, // >365d but see below
    { id: "trace-no-rule", dataClass: "traces", createdAt: "2020-01-01T00:00:00.000Z" }, // no rule -> keep
  ];

  it("purges only records past their window", () => {
    const purge = recordsToPurge(policy(), records, now);
    const ids = purge.map((r) => r.id).sort();
    expect(ids).toEqual(["old-audit", "old-event"]);
  });

  it("keeps records whose data class has no retention rule (fail-safe)", () => {
    const purge = recordsToPurge(policy(), records, now);
    expect(purge.some((r) => r.id === "trace-no-rule")).toBe(false);
  });

  it("honours legal hold regardless of age", () => {
    const held = policy({
      retention: [
        { dataClass: "inference_events", retentionDays: 90 },
        { dataClass: "audit_log", retentionDays: 365, legalHold: true },
      ],
    });
    const purge = recordsToPurge(held, records, now);
    expect(purge.map((r) => r.id)).toEqual(["old-event"]);
  });

  it("treats the window boundary as inclusive (exactly N days old is purgeable)", () => {
    const exactly90 = [{ id: "edge", dataClass: "inference_events" as const, createdAt: "2026-08-09T00:00:00.000Z" }];
    // 2026-08-09 -> 2026-11-07 is exactly 90 days.
    expect(recordsToPurge(policy(), exactly90, now).map((r) => r.id)).toEqual(["edge"]);
  });
});
