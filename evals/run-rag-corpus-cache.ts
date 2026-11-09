import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/index.js";

/**
 * Night's new-lever research: RAG pipelines (founder mandate shape list,
 * item 4) — the shape still owed a first look per
 * docs/rnd/2026-10-25-NOTES.md's "what the next night should try" and
 * docs/rnd/lever-backlog.md's 2026-10-27 run-2 queue.
 *
 *   node --import tsx evals/run-rag-corpus-cache.ts
 *
 * The shape, grounded in how it is actually built (WebSearch, 2026-11-09):
 * a RAG endpoint retrieves a handful of chunks from a knowledge base per
 * query and inlines them fresh into the prompt every call. Two real,
 * documented facts about this shape, not assumed:
 *
 *   1. Anthropic's OWN prompt-caching guidance says that for a knowledge
 *      base under ~200K tokens, cache the WHOLE thing rather than caching
 *      per-query retrieval results — because the provider's cache matches
 *      an EXACT prefix, and two different questions almost never retrieve
 *      the identical chunk SET in the identical ORDER, so inlining picks
 *      fresh per query means the cache is handed a different prefix on
 *      nearly every call even when most of the underlying text repeats.
 *   2. `evals/run-workload-matrix.ts`'s existing "rag pipeline" arm already
 *      measured this failure directly: its cache-ttl-5m stamp gets
 *      SUPPRESSED (docs/rnd/2026-10-25-NOTES.md) because the bare system
 *      prompt alone never clears the 1,024-token cacheable minimum — the
 *      shape has nothing stable large enough to cache UNTIL something
 *      hoists the repeating retrieval content itself into the prefix.
 *
 * `ragCorpusCache` (packages/sdk-js/src/reduce-request.ts) is that lever:
 * grow an append-only, cache-stable corpus of every distinct chunk this
 * route has retrieved, placed in the system prompt, and reference chunks
 * from the question by a short `[corpus#N]` marker instead of inlining
 * their text fresh. This eval measures THREE arms, lossy kept honestly
 * separate from lossless, same convention as run-memory-agent-dedup.ts:
 *
 *   A. raw            - no MESH, Anthropic cache unavailable (the measured
 *                        default: Anthropic's cache is opt-in).
 *   B. lossless stack - duplicateContext + repairCachePrefix + the 5m cache
 *                        stamp. This is what run-workload-matrix.ts already
 *                        reports for "rag pipeline": a small win from prefix
 *                        repair and duplicate removal, and the cache stamp
 *                        itself earns nothing (suppressed, below minimum).
 *   C. B + ragCorpusCache (NEW, LOSSY) - every chunk a question depends on
 *                        is still sent, in full, inside the corpus block;
 *                        only its position relative to the question moves.
 *                        Reported separately and labelled LOSSY: the model
 *                        must now resolve a `[corpus#N]` reference instead
 *                        of reading the excerpt where it used to sit, which
 *                        is a real behaviour change needing a replay-gate
 *                        pass (packages/sdk-js/src/replay-gate.ts) on a
 *                        customer's own traffic before any saving bills.
 *
 * All figures are SIMULATOR-measured against catalogued prices, labelled so.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-19";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

const LOSSLESS: MeshTokenReductionConfig = { duplicateContext: true, repairCachePrefix: true };

const PREAMBLE =
  "You are a careful contracts assistant on a legal-ops support desk. Answer only from the retrieval " +
  "corpus provided, cite the clause number you relied on, flag anything the corpus does not cover, and " +
  "keep answers terse. ".repeat(6);

/** A 16-clause knowledge base: realistic services-agreement boilerplate. */
const CORPUS = Array.from({ length: 16 }, (_, index) =>
  `Clause ${index}: this section of the services agreement covers topic ${index} — it defines the ` +
  `relevant term, states the governing deadline, and names the party responsible for topic ${index}'s ` +
  "performance and remediation. ".repeat(3));

const QUERIES = 80;

/**
 * Deterministic pseudo-retrieval: a real retriever over a small, stable
 * knowledge base returns a few globally-relevant clauses (definitions,
 * governing law) on almost every query, plus one or two question-specific
 * clauses that vary. Clauses 0-2 play that "always relevant" role here;
 * the rest round-robin so the full corpus gets touched, and reused, many
 * times over the run — the actual redundancy this lever targets.
 */
function retrieve(queryIndex: number, k = 4): number[] {
  const always = [0, 1, 2];
  const tailSize = CORPUS.length - always.length;
  const specific = always.length + (queryIndex % tailSize);
  const secondary = always.length + ((queryIndex * 7 + 3) % tailSize);
  const picks = [...always, specific, secondary];
  return [...new Set(picks)].slice(0, k);
}

type Shaped = { atSeconds: number; request: AnyObject; outputTokens: number };

/** RAG: one-shot queries, volatile request id up top, chunks repeat across queries but rarely within one. */
function ragStream(spacingSeconds: number): Shaped[] {
  const stream: Shaped[] = [];
  for (let index = 0; index < QUERIES; index += 1) {
    const indices = retrieve(index);
    const picks = indices.map((i) => CORPUS[i]!);
    stream.push({
      atSeconds: index * spacingSeconds,
      request: {
        model: "claude-sonnet-5-5", max_tokens: 300,
        system: `request-id 123e4567-e89b-12d3-a456-4266141740${String(index % 100).padStart(2, "0")}\n${PREAMBLE}`,
        messages: [{ role: "user", content: `Context:\n${picks.join("\n")}\nQuestion ${index}: what does clause ${indices[indices.length - 1]} require?` }],
      },
      outputTokens: 150,
    });
  }
  return stream;
}

/** Flatten a request to the text the provider actually hashes — see run-memory-agent-dedup.ts for why. */
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

function measureStaticArm(
  label: string,
  stream: Shaped[],
  config: MeshTokenReductionConfig | undefined,
  policy: CachePolicy,
): { costUsd: number; stamped: number; suppressed: number } {
  let stamped = 0;
  let suppressed = 0;
  const simRequests: SimulatedRequest[] = stream.map((entry) => {
    if (!config) return { atSeconds: entry.atSeconds, prompt: wire(entry.request), outputTokens: entry.outputTokens };
    const { request, summary } = reduceRequest(entry.request, config);
    if (summary.changes.some((c) => c.lever === "cache-ttl-5m")) stamped += 1;
    if (summary.changes.some((c) => c.lever === "cache-ttl-suppressed")) suppressed += 1;
    return { atSeconds: entry.atSeconds, prompt: wire(request as AnyObject), outputTokens: entry.outputTokens };
  });
  const priced = simulateCache(simRequests, policy, price.price, { countTokens: approximateTokenCount });
  console.log(
    `${label.padEnd(32)} cost $${priced.totalCostUsd.toFixed(4)}  hit rate ${(priced.hitRate * 100).toFixed(0)}%` +
      (config ? `  cache-ttl-5m stamped ${stamped}/${stream.length}, suppressed ${suppressed}/${stream.length}` : ""),
  );
  return { costUsd: priced.totalCostUsd, stamped, suppressed };
}

/** Arm C needs sequential calls: each query's corpus depends on the previous query's. */
function measureCorpusCacheArm(
  label: string,
  stream: Shaped[],
  policy: CachePolicy,
): { costUsd: number; stamped: number; suppressed: number; finalCorpusSize: number; finalCorpusTokens: number } {
  let knownCorpus: readonly string[] = [];
  let stamped = 0;
  let suppressed = 0;
  let corpusCacheApplied = 0;
  const simRequests: SimulatedRequest[] = stream.map((entry) => {
    const lastMessage = (entry.request.messages as AnyObject[])[0]!;
    const content = lastMessage.content as string;
    // Exactly the chunk texts this query's prompt inlined (see ragStream): parsed
    // from the request itself, never re-derived from `retrieve`, so this eval
    // exercises the same contract a real caller would — "these are the chunks I
    // put in the prompt" — rather than peeking at the fixture's own generator.
    const picks = content.slice("Context:\n".length, content.indexOf("\nQuestion")).split("\n");
    const config: MeshTokenReductionConfig = {
      ...LOSSLESS,
      cacheTtl: "5m",
      ragCorpusCache: { knownCorpus, chunks: picks },
    };
    const { request, summary } = reduceRequest(entry.request, config);
    if (summary.nextKnownCorpus !== undefined) knownCorpus = summary.nextKnownCorpus;
    if (summary.changes.some((c) => c.lever === "rag-corpus-cache")) corpusCacheApplied += 1;
    if (summary.changes.some((c) => c.lever === "cache-ttl-5m")) stamped += 1;
    if (summary.changes.some((c) => c.lever === "cache-ttl-suppressed")) suppressed += 1;
    return { atSeconds: entry.atSeconds, prompt: wire(request as AnyObject), outputTokens: entry.outputTokens };
  });
  const priced = simulateCache(simRequests, policy, price.price, { countTokens: approximateTokenCount });
  const finalCorpusTokens = knownCorpus.reduce((sum, text) => sum + approximateTokenCount(text), 0);
  console.log(
    `${label.padEnd(32)} cost $${priced.totalCostUsd.toFixed(4)}  hit rate ${(priced.hitRate * 100).toFixed(0)}%  ` +
      `cache-ttl-5m stamped ${stamped}/${stream.length}, suppressed ${suppressed}/${stream.length}  ` +
      `rag-corpus-cache applied ${corpusCacheApplied}/${stream.length}  final corpus ${knownCorpus.length}/${CORPUS.length} ` +
      `chunks (~${finalCorpusTokens} tok)`,
  );
  return { costUsd: priced.totalCostUsd, stamped, suppressed, finalCorpusSize: knownCorpus.length, finalCorpusTokens };
}

function run(label: string, spacingSeconds: number, policy: CachePolicy): void {
  console.log(`\n=== ${label}: ${QUERIES} one-shot queries, ${spacingSeconds}s apart, retrieving 4 of ${CORPUS.length} clauses each ===`);
  const stream = ragStream(spacingSeconds);
  const raw = measureStaticArm("A. raw (no MESH)", stream, undefined, ANTHROPIC_NO_CACHE);
  const lossless = measureStaticArm("B. lossless stack + 5m stamp", stream, { ...LOSSLESS, cacheTtl: "5m" }, policy);
  const withCorpusCache = measureCorpusCacheArm("C. B + ragCorpusCache", stream, policy);

  const losslessVsRaw = ((raw.costUsd - lossless.costUsd) / raw.costUsd) * 100;
  const corpusVsLossless = ((lossless.costUsd - withCorpusCache.costUsd) / lossless.costUsd) * 100;
  const corpusVsRaw = ((raw.costUsd - withCorpusCache.costUsd) / raw.costUsd) * 100;

  console.log(`B vs A (lossless stack alone, QUALIFIED): ${losslessVsRaw.toFixed(1)}%`);
  console.log(`C vs B (ragCorpusCache's OWN incremental effect, LOSSY, candidate only): ${corpusVsLossless.toFixed(1)}%`);
  console.log(`C vs A (full stack including the lossy lever, LOSSY, candidate only): ${corpusVsRaw.toFixed(1)}%`);
  if (withCorpusCache.costUsd >= lossless.costUsd) {
    console.log("WARNING: ragCorpusCache did not beat the lossless stack on this spacing — a finding, not a failure.");
  }
}

console.log(`MESH new-lever research: RAG pipeline, catalogued claude-sonnet-5-5 prices (${AT})`);

run("busy RAG endpoint", 20, ANTHROPIC_CACHE_5M);
run("sparse RAG endpoint (TTL-hostile control)", 400, ANTHROPIC_CACHE_5M);

console.log(
  "\ncaveat: simulator-measured, same provider-rule cache simulator every other eval in this repo uses. B's own " +
    "cache-ttl-5m stamp is expected to be SUPPRESSED (below the 1,024-token minimum): the bare RAG system prompt " +
    "alone is too small to cache, matching docs/rnd/2026-10-25-NOTES.md's existing finding for this shape. C is " +
    "NOT a qualified win: every chunk a question depends on is still sent in full inside the corpus block, but it " +
    "is no longer adjacent to the question, which is a real behaviour change — needs a replay-gate pass on a " +
    "customer's own retrieval traffic (packages/sdk-js/src/replay-gate.ts) before any part of its saving may be " +
    "billed. Reported honestly as a measured candidate, not a claim.",
);
