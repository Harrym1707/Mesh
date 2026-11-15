import type { TokenPrice } from "../../core/dist/src/cost.js";
import { gateProofFrom, type TheoGateProof } from "./theo-policy.js";
import {
  replayGate,
  toolSelectionGrader,
  type ReplayCandidate,
  type ReplayGateResult,
  type ReplayGrader,
} from "./replay-gate.js";

/**
 * The replay-gate harness for the Tool Search deferral lever.
 *
 * Tool Search is needs-verification: deferring tool definitions can change which
 * tool the model picks, so Mesh never bills its saving until it is proven on the
 * customer's own traffic. This harness runs that proof. It replays a corpus both
 * ways — baseline (full catalogue) and candidate (search tool injected, the tail
 * deferred) — reads the realised input-token drop from the provider's reported
 * usage, and grades with toolSelectionGrader, the one grader whose risk matches
 * this lever: did the model still call the same tools once some were deferred?
 *
 * WHERE THE SAVING LIVES. Deferral only cuts tokens on COLD / cache-miss turns:
 * a cache-warm turn already discounts the tool prefix to ~0.1x, so deferring it
 * buys almost nothing. To measure the lever where it actually pays, the corpus
 * should be cold turns — first turns of distinct sessions, or requests with
 * distinct tool prefixes — and `beforeRun` should clear any provider cache state
 * between the baseline and candidate runs. Without a reset the baseline warms the
 * cache the candidate then reads from, which flatters nothing here (it only
 * shrinks the measured saving) but muddies the number; the harness notes when no
 * reset was given.
 *
 * On approval it returns a publishable TheoGateProof and the resident-tool count
 * that held, so Theo can publish the lever with the exact params it was proven
 * at. On rejection the proof is undefined and the lever stays held.
 */
export type ToolSearchGateOptions = {
  /** A representative sample of real requests — cold turns, ideally (see above). */
  requests: unknown[];
  /** Sends a request and returns the provider's response. */
  call: (request: unknown) => Promise<unknown>;
  /** The route's quality ceiling, in percent. Maps to the gate's maximumQualityDrop. Default 2. */
  qualityCeilingPercent?: number;
  /**
   * Resident-tool counts to try. The gate bounds them simultaneously and keeps
   * the most aggressive that holds quality, so a sweep like [3, 4, 5] is safe —
   * the simultaneous band already pays for having picked the best. Default [4].
   */
  residentToolsCandidates?: number[];
  /** Search tool variant to inject. Default follows the reducer default (bm25). */
  variant?: "regex" | "bm25";
  /** Minimum catalogue size before deferral is attempted. Passed through to the reducer. */
  minTools?: number;
  /** Quality grader. Default toolSelectionGrader — the grader whose risk matches this lever. */
  grade?: ReplayGrader;
  /**
   * Name recorded on the proof for what graded it. Defaults to "tool-selection"
   * with the default grader, else "custom". Pass "task-completion" when supplying
   * taskCompletionGrader so the proof says honestly how quality was judged.
   */
  graderLabel?: string;
  /** Recorded baseline responses, to avoid paying for the baseline run again. */
  baselineResponses?: unknown[];
  /** Clears provider cache state between runs (see the cold-turn note above). */
  beforeRun?: (label: string) => void | Promise<void>;
  /** Group label per request, so correlated turns do not overstate the bound. */
  groupOf?: (request: unknown, index: number) => string;
  /** Rate used to express savings in money as well as tokens. */
  price?: TokenPrice;
  bootstrapSamples?: number;
  seed?: string;
  /** Clock for the proof's provenAt. Default Date.now via toISOString. */
  now?: () => string;
};

export type ToolSearchGateOutcome = {
  /** The full gate result — every candidate's verdict, saving and quality delta. */
  result: ReplayGateResult;
  /** The publishable proof if a candidate held quality; undefined keeps the lever held. */
  proof?: TheoGateProof;
  /** Resident-tool count of the approved candidate, for the published lever's params. */
  approvedResidentTools?: number;
};

/** Pull the residentTools of a tool-search candidate config back out, for the proof's params. */
function residentToolsOf(config: ReplayCandidate["config"]): number | undefined {
  const ts = config.toolSearch;
  if (ts && typeof ts === "object" && typeof ts.residentTools === "number") return ts.residentTools;
  return undefined;
}

export async function toolSearchGate(options: ToolSearchGateOptions): Promise<ToolSearchGateOutcome> {
  const ceilingPercent = options.qualityCeilingPercent ?? 2;
  const residents = options.residentToolsCandidates ?? [4];
  if (residents.length === 0) throw new Error("toolSearchGate needs at least one resident-tool count to try.");

  const candidates: ReplayCandidate[] = residents.map((n) => ({
    label: `tool-search-defer resident=${n}`,
    config: {
      toolSearch: {
        ...(options.variant ? { variant: options.variant } : {}),
        residentTools: n,
        ...(typeof options.minTools === "number" ? { minTools: options.minTools } : {}),
      },
    },
  }));

  const result = await replayGate({
    requests: options.requests,
    call: options.call,
    candidates,
    grade: options.grade ?? toolSelectionGrader,
    maximumQualityDrop: ceilingPercent / 100,
    ...(options.baselineResponses ? { baselineResponses: options.baselineResponses } : {}),
    ...(options.beforeRun ? { beforeRun: options.beforeRun } : {}),
    ...(options.groupOf ? { groupOf: options.groupOf } : {}),
    ...(options.price ? { price: options.price } : {}),
    ...(typeof options.bootstrapSamples === "number" ? { bootstrapSamples: options.bootstrapSamples } : {}),
    ...(options.seed ? { seed: options.seed } : {}),
  });

  // Make the cold-turn caveat visible on the verdict when the caller did not
  // reset the cache and did pay for a fresh baseline run.
  if (!options.beforeRun && !options.baselineResponses) {
    result.notes.push(
      "No cache reset between runs (beforeRun not supplied): if the corpus shares tool prefixes the candidate " +
      "run reads a cache the baseline warmed, so the measured Tool Search saving is a lower bound on the true " +
      "cold-turn saving.",
    );
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  // The proof records what actually graded it: the caller's explicit label if
  // given, else the default grader's name, else "custom" for a supplied grader.
  const graderLabel = options.graderLabel ?? (options.grade ? "custom" : "tool-selection");
  const proof = result.approved ? gateProofFrom(result.approved, { grader: graderLabel, at }) : undefined;
  const approvedResidentTools = result.approved ? residentToolsOf(result.approved.config) : undefined;

  return {
    result,
    ...(proof ? { proof } : {}),
    ...(approvedResidentTools !== undefined ? { approvedResidentTools } : {}),
  };
}
