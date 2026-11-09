import type { TokenPrice } from "../../core/dist/src/cost.js";
import { agentGrader } from "./graders.js";
import { replayGate, type ReplayGrader } from "./replay-gate.js";
import { leverToReductionConfig } from "./theo-policy.js";
import type { TheoProof } from "./theo-agent.js";

/**
 * The replay gate, wired to Theo.
 *
 * `runTheoCycle` consumes proofs but never produces one. This is where a proof
 * comes from: replay a sample of the customer's OWN requests both ways — baseline
 * and candidate-reduced — against the real provider, and measure what actually
 * happened. Token savings and cost come from the provider's reported usage on
 * both runs; quality from a grader comparing the two responses. A candidate is a
 * proof only if the bill fell AND the measured quality drop stayed within budget.
 *
 * This is the one impure corner of the agent: it needs a `call` that reaches the
 * provider (with the customer's key) and a sample of real requests. Both stay on
 * the customer's machine; nothing is uploaded. Replay costs money — each request
 * is sent again — so the call count is reported, and recorded baseline responses
 * can be supplied to avoid paying for the baseline run twice.
 */

export type ProveCandidatesOptions = {
  /** Enforceable lossy lever ids to prove — typically Theo's ranked hypotheses. */
  levers: readonly string[];
  /** A representative sample of the customer's real requests. */
  requests: readonly unknown[];
  /** Sends a request to the provider and returns the response. */
  call: (request: unknown) => Promise<unknown>;
  /** Clock for each proof's provenAt. */
  now: string;
  /**
   * Mean quality the gate may give up, as a FRACTION (0.02 = a 2% drop). Pass the
   * route's quality ceiling / 100 so the gate and Theo's ceiling agree. Default 0.02.
   */
  maximumQualityDrop?: number;
  /** Recorded baseline responses (one per request) to avoid paying for the baseline run. */
  baselineResponses?: readonly unknown[];
  /** Rate, so the gate judges the BILL (cache writes/reads included), not only tokens. */
  price?: TokenPrice;
  /** Quality grader. Default `agentGrader()`: a changed tool call fails hard, else coverage. */
  grader?: ReplayGrader;
  /** A short name for the grader, recorded on the proof. Default "agent". */
  graderName?: string;
  /** Group correlated requests (e.g. by task) so the quality bound is not overstated. */
  groupOf?: (request: unknown, index: number) => string;
};

export type ProveCandidatesResult = {
  /** One proof per candidate the gate approved — ready to hand to `runTheoCycle`. */
  proofs: TheoProof[];
  /** Candidates the gate rejected, with why (quality or no saving). */
  rejections: Array<{ lever: string; reason: string }>;
  /** Provider calls this replay made, so its cost is visible. */
  calls: number;
};

/**
 * Prove a set of candidate lossy levers on the customer's own traffic.
 *
 * Runs ONE replay gate across all candidates so the baseline is paid for once and
 * the quality bound holds simultaneously across the search (picking the best of
 * several otherwise flatters the winner). Each approved candidate becomes a
 * {@link TheoProof}; the measured quality bound (one-sided, ≤ 0) is carried as a
 * percentage so Theo's ceiling check compares like with like.
 */
export async function proveCandidates(options: ProveCandidatesOptions): Promise<ProveCandidatesResult> {
  const levers = [...new Set(options.levers)];
  if (levers.length === 0) return { proofs: [], rejections: [], calls: 0 };
  if (options.requests.length === 0) {
    return { proofs: [], rejections: levers.map((lever) => ({ lever, reason: "no request sample to replay" })), calls: 0 };
  }

  const candidates = levers.map((lever) => ({
    label: lever,
    config: leverToReductionConfig({ lever, class: "lossy" }),
  }));

  const result = await replayGate({
    requests: [...options.requests],
    call: options.call,
    candidates,
    grade: options.grader ?? agentGrader(),
    maximumQualityDrop: options.maximumQualityDrop ?? 0.02,
    ...(options.baselineResponses ? { baselineResponses: [...options.baselineResponses] } : {}),
    ...(options.price ? { price: options.price } : {}),
    ...(options.groupOf ? { groupOf: options.groupOf } : {}),
  });

  const graderName = options.graderName ?? "agent";
  const proofs: TheoProof[] = [];
  const rejections: Array<{ lever: string; reason: string }> = [];
  for (const candidate of result.candidates) {
    if (candidate.approved) {
      proofs.push({
        lever: candidate.label,
        // Prefer the cost saving (the bill) when priced; fall back to tokens.
        savingPercent: candidate.costSavingPercent ?? candidate.tokenSavingPercent,
        // One-sided 95% quality bound, a fraction ≤ 0; expressed as a signed percent.
        qualityDeltaPercent: candidate.lower95QualityDelta * 100,
        grader: graderName,
        provenAt: options.now,
      });
    } else {
      rejections.push({ lever: candidate.label, reason: candidate.rejectionReason ?? "not approved by the gate" });
    }
  }
  return { proofs, rejections, calls: result.calls };
}
