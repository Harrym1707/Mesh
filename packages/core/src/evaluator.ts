import type {
  EvaluationInput,
  Evaluator,
  QualityPolicy,
  QualityResult,
} from "./types.js";

/**
 * Apply a quality policy to a measured result, returning the result with
 * `passed` narrowed to whether every requirement is met.
 *
 * The error-rate and latency ceilings are fail-closed: a ceiling the result
 * does not actually measure cannot be certified as met, so an unmeasured
 * `maxErrorRate` or `maxLatencyMs` fails the gate rather than silently passing.
 * This closes the "never silently reduce quality" hole where a candidate gated
 * on error rate or latency would otherwise clear a gate it never proved.
 */
export function applyQualityPolicy(
  result: QualityResult,
  policy: QualityPolicy,
): QualityResult {
  const required = policy.requiredChecks ?? [];

  const requiredChecksPassed = required.every(
    (check) => result.checks[check] === true,
  );

  const scorePassed =
    policy.minimumScore === undefined ||
    (result.score !== undefined && result.score >= policy.minimumScore);

  const errorRatePassed =
    policy.maxErrorRate === undefined ||
    (result.errorRate !== undefined && result.errorRate <= policy.maxErrorRate);

  const latencyPassed =
    policy.maxLatencyMs === undefined ||
    (result.latencyMs !== undefined && result.latencyMs <= policy.maxLatencyMs);

  const passed =
    result.passed &&
    requiredChecksPassed &&
    scorePassed &&
    errorRatePassed &&
    latencyPassed;

  const reason = passed
    ? result.reason
    : !result.passed
      ? "quality_policy_failed"
      : !requiredChecksPassed
        ? "required_checks_failed"
        : !scorePassed
          ? "minimum_score_not_met"
          : !errorRatePassed
            ? "max_error_rate_exceeded"
            : !latencyPassed
              ? "max_latency_exceeded"
              : "quality_policy_failed";

  return { ...result, passed, reason };
}

export class ExactMatchEvaluator implements Evaluator {
  name = "exact_match";

  async evaluate(input: EvaluationInput): Promise<QualityResult> {
    const passed =
      JSON.stringify(input.baseline) === JSON.stringify(input.candidate);

    return {
      passed,
      score: passed ? 1 : 0,
      checks: { exact_match: passed },
      reason: passed ? "exact_match" : "candidate_differs",
    };
  }
}
