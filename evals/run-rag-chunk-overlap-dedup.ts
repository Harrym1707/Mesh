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
 * Night's new-lever research: RAG (retrieval-augmented generation) pipelines
 * (founder mandate shape list, item 4).
 *
 *   node --import tsx evals/run-rag-chunk-overlap-dedup.ts
 *
 * The shape: an application retrieves the top-k chunks for a query and
 * ships them inside one user message alongside the question. Real RAG
 * indexers chunk source documents with an OVERLAPPING stride (Databricks'
 * own long-context RAG benchmark used 512/256 = 50% overlap; 10-20% is a
 * common default elsewhere - see docs/rnd/fundamentals/rag-context-rightsizing.md,
 * which ranks this as lever T1, the best-fit black-box candidate on the
 * axis). When the retriever returns two ADJACENT chunks of the same source
 * document - a routine outcome, not a corner case - the overlap region is
 * byte-for-byte duplicated in the prompt, even though the two chunks are
 * NOT identical as wholes (each has its own non-overlapping remainder).
 *
 * MESH's existing `duplicateContext` lever (dedupeRepeatedBlocks) cannot
 * reach this: its finest granularity is a whole block or a whole LINE, and
 * a retrieved chunk is normally formatted as one unbroken line of prose, so
 * two overlapping chunks never align on a line boundary for it to match.
 * This eval measures the NEW `chunkOverlapDedup` lever (sentence-granularity
 * exact-match dedup; see packages/core/src/token-reduction.ts,
 * dedupeOverlappingSentences), which is LOSSLESS by the same standard as
 * `duplicateContext`: only an exact repeat of a sentence already kept
 * earlier in the SAME message is ever dropped, and the first occurrence
 * survives verbatim.
 *
 * Two scenarios are measured, both with a realistic retrieval mix (3 chunks
 * from one "relevant" document - the shape that produces adjacent-chunk
 * overlap - plus 2 chunks from two other, unrelated documents, which share
 * no overlap with anything):
 *
 *   TYPICAL  10 sentences/chunk, stride 8  (20% overlap - a common default)
 *   HIGH     10 sentences/chunk, stride 5  (50% overlap - Databricks' own rate)
 *
 * Arms, kept honestly separate, all priced with caching UNAVAILABLE
 * (Anthropic's cache is opt-in, and this shape's one stable prefix - the
 * system prompt - sits below the 1,024-token documented cacheable minimum,
 * so a 5m cache-TTL stamp is correctly SUPPRESSED by MESH's own guard on
 * every request here; verified below and priced the same as
 * run-memory-agent-dedup.ts prices its shape, so the comparison isolates
 * the NEW lever's token effect rather than mixing in a cache-policy choice
 * this shape can never actually use):
 *   A. raw            - no MESH at all.
 *   B. lossless stack  - toolSchemas + duplicateContext + repairCachePrefix
 *                        (today's existing stack, with NO new lever).
 *                        Demonstrates that the existing stack does not
 *                        reach this shape's redundancy.
 *   C. B + chunkOverlapDedup (NEW) - the lever under test. LOSSLESS, so
 *                        unlike a lossy candidate this does not need a
 *                        replay-gate pass to be a qualified win; it is
 *                        still reported as simulator-measured only, pending
 *                        real-traffic validation, per standing practice.
 *
 * All figures are SIMULATOR-measured against catalogued prices, labelled so.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-19";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

const LOSSLESS: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

const RAG_SYSTEM_PROMPT =
  "You are a careful retrieval-augmented assistant. Answer strictly from the retrieved excerpts below; if the " +
  "excerpts do not contain the answer, say so rather than guessing. Cite the excerpt number you used. Keep " +
  "answers terse and do not repeat the excerpts back to the user. ".repeat(3);

const TOPICS = ["refund policy", "shipping SLAs", "data retention", "authentication flow", "billing cycles", "incident response"];
const DOC_COUNT = TOPICS.length;
const SENTENCES_PER_DOC = 60;
const WINDOW = 10;
const QUERIES = 40;

function sentenceText(doc: number, index: number): string {
  const topic = TOPICS[doc % TOPICS.length];
  return `Section ${doc}.${index}: the ${topic} subsystem documentation states that condition ${index} applies ` +
    `whenever case ${doc}-${index} is triggered during normal operation, and the on-call runbook for ${topic} ` +
    "requires this to be logged before any remediation step is taken.";
}

function docSentences(doc: number): string[] {
  return Array.from({ length: SENTENCES_PER_DOC }, (_, index) => sentenceText(doc, index));
}

/** Sliding-window chunks over one document's sentences, overlapping by (WINDOW - stride) sentences. */
function chunksForDoc(doc: number, stride: number): string[] {
  const sentences = docSentences(doc);
  const chunks: string[] = [];
  for (let start = 0; start + WINDOW <= sentences.length; start += stride) {
    chunks.push(sentences.slice(start, start + WINDOW).join(" "));
  }
  return chunks;
}

/** One query's retrieval: 3 adjacent chunks from a "relevant" doc (the overlap source) + 2 unrelated chunks. */
function retrieve(query: number, stride: number): { chunks: string[]; question: string } {
  const relevantDoc = query % DOC_COUNT;
  const relevantChunks = chunksForDoc(relevantDoc, stride);
  const start = query % Math.max(1, relevantChunks.length - 2);
  const picked = [relevantChunks[start], relevantChunks[start + 1], relevantChunks[start + 2]]
    .filter((chunk): chunk is string => typeof chunk === "string");
  const otherDocs = [(relevantDoc + 1) % DOC_COUNT, (relevantDoc + 2) % DOC_COUNT];
  const extras = otherDocs.map((doc) => {
    const docChunks = chunksForDoc(doc, stride);
    return docChunks[query % docChunks.length]!;
  });
  return {
    chunks: [...picked, ...extras],
    question: `Query ${query}: what does the ${TOPICS[relevantDoc]!} runbook require in this case?`,
  };
}

/** A RAG request stream: one independent (one-shot) request per query, 20s apart. */
function ragStream(stride: number): Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> {
  const stream: Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> = [];
  for (let query = 0; query < QUERIES; query += 1) {
    const { chunks, question } = retrieve(query, stride);
    const context = chunks.map((chunk, index) => `[Excerpt ${index + 1}]\n${chunk}`).join("\n\n");
    stream.push({
      atSeconds: query * 20,
      request: {
        model: "claude-sonnet-5-5",
        max_tokens: 400,
        system: RAG_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Retrieved context:\n\n${context}\n\nQuestion: ${question}` }],
      },
      outputTokens: 180,
    });
  }
  return stream;
}

/** Flatten a request to the text the provider actually hashes (see run-memory-agent-dedup.ts for the rationale). */
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
  const priced = simulateCache(simRequests, ANTHROPIC_NO_CACHE, price.price, { countTokens: approximateTokenCount });
  const leverCounts = new Map<string, number>();
  for (const note of notes) leverCounts.set(note, (leverCounts.get(note) ?? 0) + 1);
  console.log(
    `${label.padEnd(30)} tokens ${tokensBefore.toString().padStart(9)} -> ${tokensAfter.toString().padStart(9)}  ` +
      `cost $${priced.totalCostUsd.toFixed(4)}  levers: ${[...leverCounts.entries()].map(([id, n]) => `${id}x${n}`).join(", ") || "none"}`,
  );
  return { costUsd: priced.totalCostUsd, tokensBefore, tokensAfter, notes };
}

function runScenario(label: string, stride: number): void {
  const overlapSentences = WINDOW - stride;
  console.log(`\n=== ${label}: ${WINDOW} sentences/chunk, stride ${stride} (${overlapSentences}/${WINDOW} sentences overlap on adjacent chunks), ${QUERIES} one-shot queries ===`);
  const stream = ragStream(stride);
  const raw = measureArm("A. raw (no MESH)", stream, undefined);
  const lossless = measureArm("B. lossless stack (no new lever)", stream, { ...LOSSLESS, cacheTtl: "5m" });
  const withLever = measureArm("C. B + chunkOverlapDedup", stream, { ...LOSSLESS, cacheTtl: "5m", chunkOverlapDedup: true });

  const losslessVsRaw = ((raw.costUsd - lossless.costUsd) / raw.costUsd) * 100;
  const leverVsLossless = ((lossless.costUsd - withLever.costUsd) / lossless.costUsd) * 100;
  const leverVsRaw = ((raw.costUsd - withLever.costUsd) / raw.costUsd) * 100;

  console.log("--- result ---");
  console.log(`B vs A (existing lossless stack alone): ${losslessVsRaw.toFixed(1)}%`);
  console.log(`C vs B (chunkOverlapDedup's OWN incremental effect, LOSSLESS): ${leverVsLossless.toFixed(1)}%`);
  console.log(`C vs A (full stack including the new lever): ${leverVsRaw.toFixed(1)}%`);
  const blockDedupeFired = lossless.notes.includes("duplicate-context-removal");
  console.log(
    `existing duplicateContext lever fired on this shape: ${blockDedupeFired} ` +
      "(expected false - its finest granularity is a whole line, and these chunks are single-line prose, " +
      "so stride overlap never aligns to a line boundary for it to match)",
  );
  if (withLever.costUsd >= lossless.costUsd) {
    console.log("WARNING: chunkOverlapDedup did not beat the lossless stack on this scenario - a finding, not a failure.");
    process.exitCode = 1;
  }
}

console.log("MESH new-lever research: RAG (retrieval-augmented generation) pipelines, overlapping retrieved chunks");
console.log(`catalogued claude-sonnet-5-5 prices (${AT})`);

runScenario("TYPICAL overlap", 8);
runScenario("HIGH overlap (Databricks-style 50% stride)", 5);

console.log(
  "\ncaveat: chunks here are built on SENTENCE boundaries, so every overlapping span is a whole-sentence exact " +
    "match - the case chunkOverlapDedup is built to catch. A real indexer that windows by raw character/token " +
    "count rather than sentence count will sometimes cut mid-sentence, in which case the overlapping run is a " +
    "near-duplicate rather than an exact one and this lever (by design, to stay lossless) will not touch it - " +
    "the measured number here is an upper bound for that class of indexer, not a floor. Simulator-measured " +
    "against catalogued prices; real-traffic validation (a live RAG workload export) is still open.",
);
