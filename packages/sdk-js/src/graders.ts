import {
  responseText,
  responseToolCalls,
  toolSelectionGrader,
  type ReplayComparison,
  type ReplayGrader,
  type ToolCall,
} from "./replay-gate.js";

/**
 * Continuous quality graders.
 *
 * The binary graders in replay-gate.ts score 1 or 0, which is right for tool
 * choice: the model either called the tool it would have called, or it did not.
 * It is wrong for everything measured by degree.
 *
 * The cost of getting this wrong was measured. With a pass/fail grader that
 * scored any truncated answer as a total failure, every output cap that actually
 * bound was rejected, and the gate settled for 32.3% while 39.7% and 51.5% sat
 * on the table. An answer cut off at 2,000 of 2,200 tokens is not a failure;
 * it is a slightly shorter answer. Grading it zero throws away a real saving.
 *
 * These graders return values in between, so the guardrail compares like with
 * like: a 2% mean quality budget should be spendable on many slightly shorter
 * answers, not only on a 2% chance of total failure.
 */

/** Word-ish tokens, lowercased, for overlap comparison. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
}

/** Multiset overlap count. */
function overlap(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const word of left) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of right) {
    const remaining = counts.get(word) ?? 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(word, remaining - 1);
    }
  }
  return shared;
}

/**
 * Harmonic mean of precision and recall over word overlap.
 *
 * Standard summarisation-style scoring, and it degrades gracefully in exactly
 * the way truncation does: an answer carrying 90% of the baseline's content
 * scores near 0.95 rather than 0, because its precision is intact and only its
 * recall fell.
 */
export const textSimilarityGrader: ReplayGrader = ({ baselineResponse, candidateResponse }) => {
  const baseline = words(responseText(baselineResponse));
  const candidate = words(responseText(candidateResponse));
  if (baseline.length === 0 && candidate.length === 0) return 1;
  if (baseline.length === 0 || candidate.length === 0) return 0;
  const shared = overlap(baseline, candidate);
  if (shared === 0) return 0;
  const precision = shared / candidate.length;
  const recall = shared / baseline.length;
  return (2 * precision * recall) / (precision + recall);
};

export type TruncationOptions = {
  /**
   * Share of the baseline's content below which a truncated answer counts as
   * useless rather than merely shorter. Default 0.5.
   */
  uselessBelowCoverage?: number;
  /**
   * Penalty applied to an answer the provider marked as cut off, on top of its
   * coverage. Default 0.05, so being visibly truncated costs a little even when
   * almost everything survived.
   */
  truncationPenalty?: number;
};

/** Whether the provider said it stopped because it ran out of room. */
function wasTruncated(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const row = response as Record<string, unknown>;
  if (row.finish_reason === "length" || row.stop_reason === "max_tokens") return true;
  if (row.incomplete_details !== null && typeof row.incomplete_details === "object") {
    const reason = (row.incomplete_details as Record<string, unknown>).reason;
    if (reason === "max_output_tokens" || reason === "max_tokens") return true;
  }
  if (Array.isArray(row.choices)) {
    return row.choices.some((choice) =>
      typeof choice === "object" && choice !== null &&
      (choice as Record<string, unknown>).finish_reason === "length");
  }
  return false;
}

/**
 * Scores a possibly-truncated answer by how much of the baseline's content it
 * still carries, rather than failing it outright.
 *
 * Below `uselessBelowCoverage` the answer is treated as a failure, because an
 * answer cut off in its first third usually is one. Above it, the score is the
 * coverage less a small penalty for being visibly incomplete.
 */
export function truncationAwareGrader(options: TruncationOptions = {}): ReplayGrader {
  const floor = options.uselessBelowCoverage ?? 0.5;
  const penalty = options.truncationPenalty ?? 0.05;
  if (floor < 0 || floor > 1) throw new Error("uselessBelowCoverage must be between 0 and 1.");
  if (penalty < 0 || penalty > 1) throw new Error("truncationPenalty must be between 0 and 1.");

  return (comparison: ReplayComparison) => {
    const baseline = words(responseText(comparison.baselineResponse));
    const candidate = words(responseText(comparison.candidateResponse));
    const truncated = wasTruncated(comparison.candidateResponse);
    if (!truncated) return 1;
    if (baseline.length === 0) return 1;
    const coverage = Math.min(1, candidate.length / baseline.length);
    if (coverage < floor) return 0;
    return Math.max(0, coverage - penalty);
  };
}

export type WeightedGrader = { grader: ReplayGrader; weight: number };

/**
 * Weighted mean of several graders.
 *
 * A reduction can fail in unrelated ways at once: trimming descriptions changes
 * which tool is called, capping output shortens the answer. One number has to
 * account for both, and a single grader only sees one of them.
 */
export function compositeGrader(parts: WeightedGrader[]): ReplayGrader {
  if (parts.length === 0) throw new Error("A composite grader needs at least one part.");
  if (parts.some((part) => !Number.isFinite(part.weight) || part.weight <= 0)) {
    throw new Error("Composite grader weights must be positive finite numbers.");
  }
  const total = parts.reduce((sum, part) => sum + part.weight, 0);
  return async (comparison: ReplayComparison) => {
    let score = 0;
    for (const part of parts) {
      const value = await part.grader(comparison);
      score += (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0) * part.weight;
    }
    return score / total;
  };
}

/**
 * Fails outright when the tool choice changed, and otherwise scores by how
 * complete the answer is.
 *
 * The right default for an agent workload. A changed tool call is a different
 * action taken in the world and no amount of eloquence redeems it, so it is a
 * hard zero. A shorter answer is a matter of degree.
 */
export function agentGrader(options: TruncationOptions = {}): ReplayGrader {
  const truncation = truncationAwareGrader(options);
  return async (comparison: ReplayComparison) => {
    const baselineCalls = responseToolCalls(comparison.baselineResponse);
    const candidateCalls = responseToolCalls(comparison.candidateResponse);
    if (baselineCalls.length > 0 || candidateCalls.length > 0) {
      const tool = await toolSelectionGrader(comparison);
      if (tool < 1) return tool;
    }
    return truncation(comparison);
  };
}

export type TaskCompletionOptions = {
  /** Match tool calls by name only, ignoring arguments. Default false (name + args). */
  ignoreArguments?: boolean;
  /**
   * Also require the candidate to have produced non-empty answer text, so a run
   * that "saved tokens" by doing nothing cannot score a pass. Default false.
   */
  requireAnswer?: boolean;
};

/**
 * Scores whether the candidate accomplished at least what the baseline did,
 * tolerating extra exploratory steps.
 *
 * toolSelectionGrader scores the Jaccard overlap of the two call sets, so ANY
 * extra call the candidate makes drags it below 1. That is right for
 * description-trimming — a changed catalogue should not change behaviour at all —
 * but too brittle for a DEFERRAL lever on a multi-step agent: Tool Search
 * legitimately makes the model take an extra exploratory step to discover a
 * deferred tool, and penalising that would reject a trajectory that completed the
 * task correctly. This grader scores the RECALL of the baseline's actions —
 * every tool call the baseline made must also have happened in the candidate — so
 * a benign extra call costs nothing while a MISSED or WRONG required call still
 * fails. With requireAnswer, a candidate that produced no answer fails outright.
 */
export function taskCompletionGrader(options: TaskCompletionOptions = {}): ReplayGrader {
  const keyOf = options.ignoreArguments
    ? (call: ToolCall): string => call.name
    : (call: ToolCall): string => `${call.name}|${call.argumentsJson}`;
  return (comparison: ReplayComparison): number => {
    if (options.requireAnswer && responseText(comparison.candidateResponse).trim() === "") return 0;
    const baseline = responseToolCalls(comparison.baselineResponse).map(keyOf);
    const candidate = new Set(responseToolCalls(comparison.candidateResponse).map(keyOf));
    if (baseline.length === 0) {
      // No actions to reproduce: completion reduces to "did the candidate answer
      // when the baseline did". A baseline that answered and a candidate that did
      // not is the one failure; anything else is a pass.
      const baselineAnswered = responseText(comparison.baselineResponse).trim() !== "";
      const candidateAnswered = responseText(comparison.candidateResponse).trim() !== "";
      return baselineAnswered && !candidateAnswered ? 0 : 1;
    }
    const hit = baseline.filter((key) => candidate.has(key)).length;
    return hit / baseline.length;
  };
}
