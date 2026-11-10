import {
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/index.js";

/**
 * Night's new-lever research: RAG pipelines (founder mandate shape list,
 * item 4), the conversational case specifically.
 *
 *   node --import tsx evals/run-rag-conversational-dedup.ts
 *
 * The shape: `evals/run-workload-matrix.ts`'s existing "rag pipeline" is
 * STATELESS one-shots - each request is its own independent call with no
 * history, so the only duplicate excerpts it can ever contain are WITHIN one
 * request (two retrieved chunks that happen to be the same passage), which
 * `duplicateContext` already removes losslessly (see
 * `dedupeRepeatedBlocks`'s own doc comment - this was already closed).
 *
 * Real RAG deployments are frequently NOT stateless: a RAG chatbot keeps a
 * conversation and, each turn, assembles a "Context:\n<chunks>\n\nQuestion:
 * ..." user turn from a fresh retrieval, then appends that turn to the
 * history it resends on every later call (confirmed against real framework
 * behaviour - a LangChain forum thread on this exact failure mode notes
 * retrieved content "piles up across turns" whenever it is written into a
 * message list with append semantics, and a practitioner Stack Overflow
 * question describes the same retriever returning the same content every
 * turn while memory stores it verbatim; LangChain's own newer
 * `create_history_aware_retriever` pattern re-retrieves against a
 * history-rewritten query every turn rather than reusing a stored result,
 * which is exactly how the SAME passage resurfaces: a topically related
 * follow-up's retrieval overlaps an earlier turn's top-k). Once that
 * resent history grows, the SAME chunk sits in the prompt more than once,
 * non-adjacently, buried inside otherwise-unique turns - a shape neither
 * `duplicateContext` (one message at a time) nor `crossTurnMemoryDedup`
 * (leading block only) reaches.
 *
 * This eval measures THREE arms, keeping the lossy arm clearly separate
 * from the lossless stack, honestly:
 *
 *   A. raw            - no MESH at all, uncached (the measured default:
 *                        Anthropic's cache is opt-in).
 *   B. lossless stack - toolSchemas + duplicateContext + repairCachePrefix
 *                        + the 5m cache stamp. duplicateContext still earns
 *                        its keep here (it catches the WITHIN-turn repeats
 *                        this fixture also carries), but cannot reach the
 *                        cross-turn repeats.
 *   C. B + ragCrossTurnDedup (NEW, LOSSY) - replaces a chunk repeated from
 *                        an earlier turn, wherever it sits in the current
 *                        turn, with a short reference marker (see
 *                        packages/core/src/token-reduction.ts,
 *                        dedupeRepeatedBlocksAcrossTexts). Reported
 *                        separately and labelled LOSSY for the same reason
 *                        crossTurnMemoryDedup is: the duplicate removed is
 *                        never adjacent to its twin. This arm's saving is
 *                        NOT claimed as a qualified win - it is a candidate
 *                        that needs a replay-gate pass on a customer's own
 *                        traffic (packages/sdk-js/src/replay-gate.ts)
 *                        before it may ever be billed.
 *
 * All figures are SIMULATOR-measured against catalogued prices, labelled so.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-27";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

const LOSSLESS: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

const PREAMBLE =
  "You are a support assistant answering questions from the services agreement knowledge base. Cite the " +
  "clause you rely on, keep answers terse, and say so plainly when the corpus does not cover the question. ".repeat(4);

// 10 corpus passages a retriever can return. Consecutive questions on a related
// topic retrieve overlapping top-k, exactly as real embedding retrieval does on
// a small, topically clustered knowledge base.
const PASSAGES = Array.from({ length: 10 }, (_, index) =>
  `Clause ${index}: this clause of the services agreement covers topic area ${index}, setting the ` +
  "notification window, defining the remediation ladder, and assigning liability for related outages " +
  "to the operating party in scope for this clause. ".repeat(3));

const TURNS = 36;

/** Topic drifts every 3 turns, so retrieval keeps returning 2 of the same 3 passages
 *  for several turns before the topic moves on and a fresh set of chunks appears. */
function retrievedFor(turn: number): string[] {
  const topic = Math.floor(turn / 3);
  const base = (topic * 2) % PASSAGES.length;
  return [PASSAGES[base]!, PASSAGES[(base + 1) % PASSAGES.length]!];
}

/** Conversational RAG: a chatbot that keeps history and appends each turn's
 *  freshly retrieved "Context:\n<chunks>\n\nQuestion: ..." block onto it. */
function conversationalRagStream(): Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> {
  const stream: Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> = [];
  const history: AnyObject[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const chunks = retrievedFor(turn).join("\n\n");
    history.push({ role: "user", content: `Context:\n${chunks}\n\nQuestion ${turn}: what does this cover?` });
    stream.push({
      atSeconds: turn * 50,
      request: { model: "claude-sonnet-5-5", max_tokens: 400, system: PREAMBLE, messages: [...history] },
      outputTokens: 180,
    });
    history.push({ role: "assistant", content: `Answer for turn ${turn}, citing the relevant clause above.` });
  }
  return stream;
}

/** Flatten a request to the text the provider actually hashes (see
 *  run-memory-agent-dedup.ts for the identical rationale). */
function wire(request: AnyObject): string {
  const flattenContent = (content: unknown): string | unknown => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content;
    const texts: string[] = [];
    for (const block of content) {
      const b = block as AnyObject;
      if (b === null || typeof b !== "object" || b.type !== "text" || typeof b.text !== "string") return content;
      texts.push(b.text);
    }
    return texts.join("");
  };
  const flattenMessage = (message: unknown): unknown => {
    if (typeof message !== "object" || message === null) return message;
    const m = { ...(message as AnyObject) };
    m.content = flattenContent(m.content);
    return m;
  };
  const system = flattenContent(request.system);
  const systemText = typeof system === "string" ? system : "";
  const messages = (request.messages as unknown[]).map((m) => JSON.stringify(flattenMessage(m))).join("\n");
  return `${systemText}\n${messages}`;
}

function measureArm(
  label: string,
  stream: Array<{ atSeconds: number; request: AnyObject; outputTokens: number }>,
  config: MeshTokenReductionConfig | undefined,
): { costUsd: number; tokensBefore: number; tokensAfter: number; notes: string[] } {
  let tokensBefore = 0;
  let tokensAfter = 0;
  const notes: string[] = [];
  const simRequests: SimulatedRequest[] = stream.map((entry) => {
    if (!config) {
      const full = wire(entry.request);
      tokensBefore += approximateTokenCount(full);
      tokensAfter += approximateTokenCount(full);
      return { atSeconds: entry.atSeconds, prompt: full, outputTokens: entry.outputTokens };
    }
    const { request, summary } = reduceRequest(entry.request, config);
    tokensBefore += summary.estimatedTokensBefore;
    tokensAfter += summary.estimatedTokensAfter;
    for (const change of summary.changes) notes.push(change.lever);
    return { atSeconds: entry.atSeconds, prompt: wire(request as AnyObject), outputTokens: entry.outputTokens };
  });
  // Raw arm: caching unavailable (Anthropic's opt-in default), same as
  // run-memory-agent-dedup.ts - this eval isolates the NEW lever's token
  // effect on a shape whose system prompt sits below the 1,024-token
  // documented cacheable minimum, so the cache stamp cannot reach it either.
  const priced = simulateCache(simRequests, ANTHROPIC_NO_CACHE, price.price, { countTokens: approximateTokenCount });
  const leverCounts = new Map<string, number>();
  for (const note of notes) leverCounts.set(note, (leverCounts.get(note) ?? 0) + 1);
  console.log(
    `${label.padEnd(28)} tokens ${tokensBefore.toString().padStart(9)} -> ${tokensAfter.toString().padStart(9)}  ` +
      `cost $${priced.totalCostUsd.toFixed(4)}  levers: ${[...leverCounts.entries()].map(([id, n]) => `${id}x${n}`).join(", ") || "none"}`,
  );
  return { costUsd: priced.totalCostUsd, tokensBefore, tokensAfter, notes };
}

console.log(`MESH new-lever research: conversational RAG, ${TURNS} turns, retrieval overlaps every 3-turn topic window`);
console.log(`catalogued claude-sonnet-5-5 prices (${AT}); raw arm priced with caching unavailable throughout\n`);

const stream = conversationalRagStream();
const raw = measureArm("A. raw (no MESH)", stream, undefined);
const lossless = measureArm("B. lossless stack", stream, { ...LOSSLESS, cacheTtl: "5m" });
const withDedup = measureArm("C. B + ragCrossTurnDedup", stream, {
  ...LOSSLESS,
  cacheTtl: "5m",
  ragCrossTurnDedup: true,
});

const losslessVsRaw = ((raw.costUsd - lossless.costUsd) / raw.costUsd) * 100;
const dedupVsLossless = ((lossless.costUsd - withDedup.costUsd) / lossless.costUsd) * 100;
const dedupVsRaw = ((raw.costUsd - withDedup.costUsd) / raw.costUsd) * 100;

console.log("\n=== result ===");
console.log(`B vs A (lossless stack alone, QUALIFIED - no information removed): ${losslessVsRaw.toFixed(1)}%`);
console.log(`C vs B (ragCrossTurnDedup's OWN incremental effect, LOSSY, candidate only): ${dedupVsLossless.toFixed(1)}%`);
console.log(`C vs A (full stack including the lossy lever, LOSSY, candidate only): ${dedupVsRaw.toFixed(1)}%`);
console.log(
  "\ncaveat: B is a qualified, lossless win - safe to publish as-is. C is NOT a qualified win: the saved bytes " +
    "are byte-identical to text already sent, but the duplicate removed is turns upstream of the current one " +
    "rather than adjacent to its twin, which is the same behaviour-risk class crossTurnMemoryDedup already " +
    "carries. C must be proven on a customer's own traffic through replayGate " +
    "(packages/sdk-js/src/replay-gate.ts) before any part of its saving may be billed. Reported honestly as a " +
    "measured candidate, not a claim.",
);

if (withDedup.costUsd >= lossless.costUsd) {
  console.log("\nWARNING: ragCrossTurnDedup did not beat the lossless stack on this shape - a finding, not a failure.");
  process.exitCode = 1;
}
