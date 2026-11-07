import { describe, expect, it } from "vitest";
import { applyQualityPolicy } from "./evaluator.js";
import type { QualityPolicy, QualityResult } from "./types.js";

function result(overrides: Partial<QualityResult> = {}): QualityResult {
  return { passed: true, score: 0.99, checks: {}, reason: "ok", ...overrides };
}

describe("applyQualityPolicy", () => {
  it("passes when every requirement is met", () => {
    const policy: QualityPolicy = { minimumScore: 0.9, maxErrorRate: 0.02, maxLatencyMs: 800 };
    const evaluated = applyQualityPolicy(
      result({ score: 0.95, errorRate: 0.01, latencyMs: 500 }),
      policy,
    );
    expect(evaluated.passed).toBe(true);
    expect(evaluated.reason).toBe("ok");
  });

  describe("maxErrorRate ceiling", () => {
    const policy: QualityPolicy = { maxErrorRate: 0.02 };

    it("fails when the measured error rate breaches the ceiling", () => {
      const evaluated = applyQualityPolicy(result({ errorRate: 0.05 }), policy);
      expect(evaluated.passed).toBe(false);
      expect(evaluated.reason).toBe("max_error_rate_exceeded");
    });

    it("passes when the measured error rate is within the ceiling", () => {
      expect(applyQualityPolicy(result({ errorRate: 0.01 }), policy).passed).toBe(true);
    });

    it("fails closed when the ceiling is set but the error rate is unmeasured", () => {
      const evaluated = applyQualityPolicy(result({ errorRate: undefined }), policy);
      expect(evaluated.passed).toBe(false);
      expect(evaluated.reason).toBe("max_error_rate_exceeded");
    });
  });

  describe("maxLatencyMs ceiling", () => {
    const policy: QualityPolicy = { maxLatencyMs: 800 };

    it("fails when the measured latency breaches the ceiling", () => {
      const evaluated = applyQualityPolicy(result({ latencyMs: 1_200 }), policy);
      expect(evaluated.passed).toBe(false);
      expect(evaluated.reason).toBe("max_latency_exceeded");
    });

    it("passes when the measured latency is within the ceiling", () => {
      expect(applyQualityPolicy(result({ latencyMs: 400 }), policy).passed).toBe(true);
    });

    it("fails closed when the ceiling is set but latency is unmeasured", () => {
      const evaluated = applyQualityPolicy(result({ latencyMs: undefined }), policy);
      expect(evaluated.passed).toBe(false);
      expect(evaluated.reason).toBe("max_latency_exceeded");
    });
  });

  it("leaves behaviour unchanged when neither ceiling is configured", () => {
    expect(applyQualityPolicy(result({ errorRate: undefined, latencyMs: undefined }), { minimumScore: 0.9 }).passed).toBe(true);
  });
});
