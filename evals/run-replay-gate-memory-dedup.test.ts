import { describe, expect, it } from "vitest";
import { replayUsage } from "../packages/sdk-js/src/index.js";
import {
  buildMemoryFixtureRequests,
  factForTurn,
  nearestRestatementDistance,
  simulateRecall,
  simulatedReplyText,
} from "./memory-agent-fixture.js";
import { BOUNDED_4, BOUNDED_8, NAIVE, runMemoryDedupGate } from "./run-replay-gate-memory-dedup.js";
import { reduceRequest } from "../packages/sdk-js/src/index.js";

/**
 * Pins the properties that make the gate verdict below meaningful, the same
 * way run-replay-gate-freshcap.test.ts pins its own simulated provider: if
 * the recall model could not tell a restated fact from a dropped one, or the
 * usage it reports did not parse, the headline REJECTED/APPROVED verdicts
 * would be theatre, not evidence.
 */

describe("memory-agent fixture: the recall model the gate verdict rests on", () => {
  it("finds the fact at distance 0 when the current turn restates it unreduced", () => {
    const requests = buildMemoryFixtureRequests(5);
    const outcome = simulateRecall(requests[4]!);
    expect(outcome.distance).toBe(0);
    expect(outcome.correct).toBe(true);
  });

  it("finds a growing distance once crossTurnMemoryDedup removes the restatement", () => {
    const requests = buildMemoryFixtureRequests(10);
    const { request: reduced } = reduceRequest(requests[9]!, { crossTurnMemoryDedup: true });
    const outcome = simulateRecall(reduced as Record<string, unknown>);
    // Only turn 0 is verbatim under the default (unbounded) config; turn 9 is 9 away.
    expect(outcome.distance).toBe(9);
    expect(outcome.correct).toBe(false);
  });

  it("restateEveryTurns caps the distance at N-1 turns", () => {
    const requests = buildMemoryFixtureRequests(10);
    const { request: reduced } = reduceRequest(requests[9]!, {
      crossTurnMemoryDedup: { restateEveryTurns: 4 },
    });
    const outcome = simulateRecall(reduced as Record<string, unknown>);
    // Turn 9's nearest re-anchor (a multiple of 4) is turn 8, distance 1.
    expect(outcome.distance).toBe(1);
    expect(outcome.correct).toBe(true);
  });

  it("reports undefined distance only if the fact never appeared, which never happens from turn 0", () => {
    const requests = buildMemoryFixtureRequests(1);
    const fact = factForTurn(0);
    expect(nearestRestatementDistance(requests[0]! as Record<string, unknown>, 0, fact)).toBe(0);
  });

  it("produces a correct reply containing the fact's value, and an incorrect reply that visibly does not", () => {
    const fact = factForTurn(0);
    const correctText = simulatedReplyText({ correct: true, distance: 0, fact }, 0);
    const wrongText = simulatedReplyText({ correct: false, distance: 99, fact }, 0);
    expect(correctText).toContain(fact.value);
    expect(wrongText).not.toContain(fact.value);
  });

  it("produces responses the gate's own usage parser accepts", async () => {
    const requests = buildMemoryFixtureRequests(1);
    const outcome = simulateRecall(requests[0]! as Record<string, unknown>);
    const text = simulatedReplyText(outcome, 0);
    const usage = replayUsage({ content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20 } });
    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(100);
    expect(usage!.outputTokens).toBe(20);
  });
});

describe("replay gate over crossTurnMemoryDedup", () => {
  it("rejects the shipped (unbounded) default and restateEveryTurns 8, approves restateEveryTurns 4", async () => {
    const requests = buildMemoryFixtureRequests(40);
    const result = await runMemoryDedupGate(requests);

    const naive = result.candidates.find((c) => c.label === NAIVE.label)!;
    expect(naive.approved).toBe(false);
    expect(naive.meanQualityDelta).toBeLessThan(-0.02);

    const bounded8 = result.candidates.find((c) => c.label === BOUNDED_8.label)!;
    expect(bounded8.approved).toBe(false);

    const bounded4 = result.candidates.find((c) => c.label === BOUNDED_4.label)!;
    expect(bounded4.approved).toBe(true);
    expect(bounded4.meanQualityDelta).toBe(0);
    expect(bounded4.inputTokensSaved).toBeGreaterThan(0);
    expect(result.approved?.label).toBe(BOUNDED_4.label);
  });
});
