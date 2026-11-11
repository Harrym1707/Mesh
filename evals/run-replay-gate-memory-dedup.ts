import { pathToFileURL } from "node:url";
import { lookupPrice, publishedModelPrices } from "../packages/core/src/index.js";
import {
  replayGate,
  textSimilarityGrader,
  type ReplayCandidate,
  type ReplayGateResult,
} from "../packages/sdk-js/src/index.js";
import {
  MEMORY_RECALL_HORIZON_TURNS,
  TURNS,
  approximateRequestTokens,
  buildMemoryFixtureRequests,
  simulateRecall,
  simulatedReplyText,
  type AnyObject,
} from "./memory-agent-fixture.js";

/**
 * Night's R&D: the replay-gate pass Finding 1 (docs/rnd/2026-10-22-workload-matrix-findings.md)
 * has owed since 2026-10-23 and every night since ("real work, not a quick
 * guard" - docs/rnd/2026-10-25-NOTES.md).
 *
 *   node --import tsx evals/run-replay-gate-memory-dedup.ts
 *
 * `evals/run-memory-agent-dedup.ts` already measured crossTurnMemoryDedup's
 * TOKEN effect and labelled it a candidate, explicitly NOT a qualified win,
 * pending exactly this: a run through packages/sdk-js/src/replay-gate.ts.
 * This script is that run. See evals/memory-agent-fixture.ts for the full
 * honesty label on what is and is not measured here - in short, there is no
 * real model in this harness, so the verdict below proves the GATE
 * correctly separates an unsafe design from a safe one on a declared
 * assumption about recall-over-distance, not a real quality number. A real
 * verdict needs a replay-gate pass on a customer's own traffic with a real
 * grader (task-completion signal or LLM judge).
 *
 * Three candidates, all crossTurnMemoryDedup in ISOLATION (no other lever),
 * so the verdict is about this lever alone:
 *
 *   NAIVE      - the shipped default: only turn 0 restated verbatim, every
 *                later turn referenced. Distance grows without bound.
 *   BOUNDED_8  - restateEveryTurns: 8. Max distance 7, over the fixture's
 *                5-turn horizon on two turns out of every eight.
 *   BOUNDED_4  - restateEveryTurns: 4. Max distance 3, inside the horizon
 *                on every turn.
 *
 * Expected verdict, and the finding this script exists to put on the
 * record: NAIVE and BOUNDED_8 are REJECTED at the default 2% quality
 * budget; BOUNDED_4 is APPROVED at exactly zero quality delta. The shipped
 * default is therefore NOT safe to bill as-is - restateEveryTurns is.
 */

const AT = "2026-10-19";
const priceLookup = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (priceLookup.status !== "priced") throw new Error(priceLookup.reason);
// Captured as its own const, not used inline as `priceLookup.price`, so the narrowed
// type survives into runMemoryDedupGate's closure below (see the matching note in
// evals/run-memory-agent-dedup.ts, the latent bug this night's typecheck:evals addition found).
const price = priceLookup.price;

/** Simulated provider: answers from the declared recall assumption, nothing else. */
function createSimulatedProvider(): { call: (request: unknown) => Promise<unknown> } {
  const call = async (request: unknown): Promise<unknown> => {
    const row = request as AnyObject;
    const turn = Number((row.metadata as AnyObject).turn);
    const outcome = simulateRecall(row);
    const text = simulatedReplyText(outcome, turn);
    return {
      content: [{ type: "text", text }],
      usage: {
        input_tokens: approximateRequestTokens(row),
        output_tokens: Math.ceil(text.length / 4),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  };
  return { call };
}

export const NAIVE: ReplayCandidate = {
  label: "NAIVE (restateEveryTurns unset - shipped default)",
  config: { crossTurnMemoryDedup: true },
};
export const BOUNDED_8: ReplayCandidate = {
  label: "BOUNDED_8 (restateEveryTurns: 8, max distance 7)",
  config: { crossTurnMemoryDedup: { restateEveryTurns: 8 } },
};
export const BOUNDED_4: ReplayCandidate = {
  label: "BOUNDED_4 (restateEveryTurns: 4, max distance 3)",
  config: { crossTurnMemoryDedup: { restateEveryTurns: 4 } },
};

export async function runMemoryDedupGate(requests: AnyObject[]): Promise<ReplayGateResult> {
  const provider = createSimulatedProvider();
  return replayGate({
    requests,
    call: provider.call,
    candidates: [NAIVE, BOUNDED_8, BOUNDED_4],
    grade: textSimilarityGrader,
    price,
  });
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

async function main(): Promise<void> {
  const requests = buildMemoryFixtureRequests(TURNS);
  console.log(
    `replay gate over ${requests.length} continuous-memory-agent turns, declared recall horizon ` +
      `${MEMORY_RECALL_HORIZON_TURNS} turns (assumption, not measured - see evals/memory-agent-fixture.ts), ` +
      "default 2% quality budget",
  );
  console.log(
    "\nverdict answers: is crossTurnMemoryDedup, AS SHIPPED, safe to bill? And does bounding it with " +
      "restateEveryTurns change the answer?\n",
  );

  const result = await runMemoryDedupGate(requests);

  console.log(`provider calls paid for: ${result.calls} (baseline + one run per candidate)`);
  for (const candidate of result.candidates) {
    console.log(`\n--- ${candidate.label} ---`);
    console.log(`  graded ${candidate.graded}, failed ${candidate.failed}`);
    console.log(
      `  mean quality delta ${(candidate.meanQualityDelta * 100).toFixed(2)} pp, ` +
        `lower95 ${(candidate.lower95QualityDelta * 100).toFixed(2)} pp`,
    );
    console.log(
      `  input tokens: baseline ${candidate.baselineUsage.inputTokens.toLocaleString("en-US")} -> candidate ` +
        `${candidate.candidateUsage.inputTokens.toLocaleString("en-US")}; saved ` +
        `${candidate.inputTokensSaved.toLocaleString("en-US")} (${candidate.tokenSavingPercent.toFixed(1)}% of tokens)`,
    );
    console.log(
      `  cost: saved ${formatUsd(candidate.costSavedUsd)}` +
        (candidate.costSavingPercent === undefined ? "" : ` (${candidate.costSavingPercent.toFixed(1)}%)`),
    );
    console.log(
      `  verdict: ${candidate.approved ? "APPROVED" : "REJECTED"}` +
        (candidate.rejectionReason ? ` - ${candidate.rejectionReason}` : ""),
    );
  }
  for (const note of result.notes) console.log(`note: ${note}`);

  console.log(
    `\ngate verdict: ${result.approved ? `approved '${result.approved.label}'` : "nothing approved"} ` +
      `at the default ${(result.maximumQualityDrop * 100).toFixed(0)}% budget.`,
  );

  // Hard expectations: the finding this script exists to record.
  const naive = result.candidates.find((c) => c.label === NAIVE.label)!;
  const bounded8 = result.candidates.find((c) => c.label === BOUNDED_8.label)!;
  const bounded4 = result.candidates.find((c) => c.label === BOUNDED_4.label)!;

  if (naive.approved) {
    throw new Error(
      "Expected the shipped default (unbounded crossTurnMemoryDedup) to be REJECTED on this fixture; it was " +
        "approved - check that the recall model or the budget was not loosened to flatter it.",
    );
  }
  if (bounded8.approved) {
    throw new Error("Expected restateEveryTurns: 8 (max distance 7, over the 5-turn horizon) to be REJECTED too.");
  }
  if (!bounded4.approved) {
    throw new Error("Expected restateEveryTurns: 4 (max distance 3, inside the 5-turn horizon) to be APPROVED.");
  }
  if (bounded4.meanQualityDelta !== 0 || Math.abs(bounded4.lower95QualityDelta) > 1e-9) {
    throw new Error("Expected BOUNDED_4 to hold quality at exactly zero delta on this fixture.");
  }
  if (bounded4.inputTokensSaved <= 0) {
    throw new Error("Expected BOUNDED_4 to still save real input tokens, net of its more frequent restatement.");
  }

  console.log(
    "\nexpectations held: the shipped default and restateEveryTurns: 8 both REJECTED; restateEveryTurns: 4 " +
      `APPROVED at exactly zero delta, saving ${bounded4.tokenSavingPercent.toFixed(1)}% of tokens on this fixture. ` +
      "FINDING: crossTurnMemoryDedup's shipped default is not safe to bill under this (declared-assumption) " +
      "recall model; bounding it with restateEveryTurns is the fix, pending a real replay-gate pass on a " +
      "customer's own traffic before any part of it may be billed.",
  );
}

const isDirectRun = typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
