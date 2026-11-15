import { approximateTokenCount } from "../packages/core/src/index.js";
import {
  estimateRecall,
  flattenPrompt,
  buildFixtureRequests,
  TASKS,
  type FixtureRequest,
} from "./memory-dedup-fixture.js";
import {
  reduceRequest,
  replayGate,
  type MeshTokenReductionConfig,
  type ReplayComparison,
  type ReplayGrader,
} from "../packages/sdk-js/src/index.js";

/**
 * Replay gate for `crossTurnMemoryDedup` on the continuous-memory-agent
 * shape - the piece `docs/rnd/2026-10-23-NOTES.md` left owed for three
 * consecutive nights: "`crossTurnMemoryDedup`'s measured 58.0% candidate
 * needs a quality signal beyond 'the bytes are identical'... before any
 * part of it can move from candidate to billed."
 *
 *   node --import tsx evals/run-replay-gate-memory-dedup.ts
 *
 * Read `evals/memory-dedup-fixture.ts`'s doc comment first: the "model" this
 * script replays against is a MODELED recall-probability curve, not a real
 * LLM and not customer traffic - there is neither in this environment. The
 * verdict below answers "does this candidate clear the quality budget under
 * a deliberately-labelled, uncalibrated proxy for attention decay", which is
 * a bound worth having but is NOT itself sufficient grounds to bill the
 * lever on real traffic. Treat a REJECT here as a real reason to keep the
 * lever off; treat an APPROVE here as "the toolchain is ready, not as a
 * live-traffic proof" - the gate's own verdict text says so again below.
 */

const LOSSLESS: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

const fixture: FixtureRequest[] = buildFixtureRequests();
const requests: unknown[] = fixture.map((row) => row.request);

/**
 * The simulated "provider": reports where the needed fact ended up in the
 * prompt it was actually sent, as a modeled recall estimate. No text is
 * generated because the grader below reads this structured estimate
 * directly - there is no model output to parse, the way `agent-fixture.ts`'s
 * `answer()` scripts a tool call to parse. See the fixture's doc comment for
 * what `RecallEstimate` is and is not.
 *
 * Reads the required fact from `request.metadata`, not from the original
 * fixture object's identity: `reduceRequest` returns a NEW object for a
 * candidate's reduced request (`{ ...request }`, see reduce-request.ts), so
 * an identity-keyed lookup would miss every candidate call. `metadata` is
 * passed through untouched (the same convention `run-replay-gate-freshcap.ts`
 * relies on), so it survives reduction and identifies the request reliably.
 */
async function call(request: unknown): Promise<unknown> {
  const row = request as Record<string, unknown>;
  const metadata = row.metadata as { requiredFact?: string } | undefined;
  const fact = metadata?.requiredFact;
  if (typeof fact !== "string") throw new Error("Replayed request is missing its fixture metadata.");
  const prompt = flattenPrompt(row);
  const estimate = estimateRecall(prompt, fact);
  return {
    _estimate: estimate,
    _fact: fact,
    // Anthropic-shaped usage, read by replayGate's own token/cost accounting
    // (packages/sdk-js/src/replay-gate.ts replayUsage) - so the script's
    // reported "token saving" line is this gate's own honest measurement of
    // what reduceRequest did to the prompt, not a placeholder.
    usage: { input_tokens: approximateTokenCount(prompt), output_tokens: 40 },
  };
}

/**
 * Scores the modeled recall probability directly - 1.0 is the ceiling the
 * baseline (memory restated fresh every turn, always adjacent to the
 * question) sits at in every single request, so the delta this produces IS
 * the candidate's own cost relative to that ceiling, independent of what the
 * baseline response object happens to contain.
 */
const recallGrader: ReplayGrader = ({ candidateResponse }: ReplayComparison) => {
  const response = candidateResponse as { _estimate?: { recallProbability: number; found: boolean } };
  if (!response._estimate || !response._estimate.found) return 0;
  return response._estimate.recallProbability;
};

async function main(): Promise<void> {
  console.log(
    `MESH replay gate: crossTurnMemoryDedup on the continuous-memory-agent shape, ` +
      `${requests.length} requests (${TASKS} tasks).\n` +
      "modeled recall proxy, NOT a real model or customer traffic - see memory-dedup-fixture.ts.\n",
  );

  const result = await replayGate({
    requests,
    call,
    candidates: [
      { label: "lossless stack (no dedup) - sanity candidate", config: LOSSLESS },
      { label: "lossless + crossTurnMemoryDedup", config: { ...LOSSLESS, crossTurnMemoryDedup: true } },
    ],
    grade: recallGrader,
    groupOf: (request) => `task-${(((request as Record<string, unknown>).metadata) as { taskIndex: number }).taskIndex}`,
  });

  for (const candidate of result.candidates) {
    console.log(`${candidate.label}`);
    console.log(
      `  graded ${candidate.graded}/${candidate.graded + candidate.failed}  ` +
        `mean quality delta ${(candidate.meanQualityDelta * 100).toFixed(2)}pp  ` +
        `lower-95 bound ${(candidate.lower95QualityDelta * 100).toFixed(2)}pp  ` +
        `token saving ${candidate.tokenSavingPercent.toFixed(1)}%  ` +
        `verdict ${candidate.approved ? "APPROVED" : "REJECTED"}`,
    );
    if (candidate.rejectionReason) console.log(`  reason: ${candidate.rejectionReason}`);
  }

  console.log(`\nquality budget: ${(result.maximumQualityDrop * 100).toFixed(1)}pp (house default)`);
  console.log(`replayed calls: ${result.calls}`);
  for (const note of result.notes) console.log(`note: ${note}`);

  console.log(
    "\ncaveat (repeated from the header - do not drop this when citing the number above): the grader scores a " +
      "MODELED, uncalibrated recall-probability proxy, not a real model's output and not customer traffic. An " +
      "APPROVED verdict here means the toolchain and the fixture are ready to re-run the instant a real LLM-" +
      "judge or a customer's own traffic is available - it does NOT mean the lever may be billed. A REJECTED " +
      "verdict is a real reason to keep the lever off pending that real run, not an artifact to tune away.",
  );
}

void main();
