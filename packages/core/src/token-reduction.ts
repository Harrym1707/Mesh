import { estimateTokenCost, type TokenPrice } from "./cost.js";

/**
 * Token reduction: spend fewer tokens on the SAME model, rather than moving work
 * to a weaker one. Model substitution trades quality for cost and needs a quality
 * gate to be safe. Most of the levers here do not: removing a duplicated context
 * block, or letting a provider's prefix cache serve a prompt you already paid
 * for, changes the bill and not the answer.
 *
 * The economics that make this the primary lever rather than a secondary one,
 * using rates captured in model-prices.ts:
 *   - Output tokens cost 5x input (Claude Sonnet 5.5) to 8x (gpt-5), so trimming
 *     an over-long answer is worth several times trimming the prompt.
 *   - Cached input costs 1/20th of fresh input (Sonnet 5.5: $2.00 -> $0.10), so a
 *     stable prefix served from cache is close to free.
 *
 * Token counting here is an ESTIMATE used to decide what to cut and to project a
 * saving. It is never the basis of a realised-saving claim: those come from the
 * provider's own reported usage, priced through the catalogue. A deployment
 * should pass the tokenizer matching its model via `countTokens`, because a
 * tokenizer pinned inside MESH would drift from the provider's own counting.
 */

export type TokenCounter = (text: string) => number;

const CODE_FENCE = /```[\s\S]*?```|`[^`\n]+`/g;

/**
 * Tokenizer-free estimate. Byte-pair encoders average roughly 4 characters per
 * token on English prose and nearer 3 on code, punctuation and JSON, so this
 * counts word-like runs and separators separately instead of dividing the whole
 * string by one constant. Expect roughly +/-15% against a real tokenizer; good
 * enough to rank candidate reductions, not good enough to bill on.
 */
export const approximateTokenCount: TokenCounter = (text) => {
  if (text === "") return 0;
  let total = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}']+|[^\p{L}\p{N}'\s]+|\s+/gu)) {
    const chunk = match[0]!;
    if (/^\s+$/.test(chunk)) {
      // Runs of whitespace mostly ride along with an adjacent token; newlines do not.
      total += (chunk.match(/\n/g)?.length ?? 0);
      continue;
    }
    if (/^[\p{L}\p{N}']+$/u.test(chunk)) {
      total += Math.max(1, Math.ceil(chunk.length / 4.5));
      continue;
    }
    // Punctuation and symbols tokenize densely.
    total += Math.max(1, Math.ceil(chunk.length / 2));
  }
  return total;
};

export type ReductionRisk = "lossless" | "low" | "moderate";

export type ReductionOutcome = {
  reducer: string;
  version: string;
  risk: ReductionRisk;
  text: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** What the reducer removed, for review before anything is enabled. */
  notes: string[];
};

export type Reducer = {
  id: string;
  version: string;
  risk: ReductionRisk;
  reduce: (text: string) => { text: string; notes: string[] };
};

/**
 * Removes exact duplicate blocks. Retrieval pipelines routinely send the same
 * passage two or three times (overlapping chunks, a document that matched several
 * queries, a system prompt echoed into the first user turn). Dropping later exact
 * copies is lossless: the model already has the text.
 *
 * Only blocks at or above `minimumBlockTokens` are considered, so ordinary
 * repeated phrasing is left alone.
 *
 * Duplicates are caught at two granularities: whole blocks separated by a
 * blank line (as before), and, inside a block that survives that check,
 * individual lines separated by a single newline. A RAG prompt that joins
 * several retrieved excerpts with `picks.join("\n")` never produces a
 * duplicated top-level block — the whole joined block is unique per request
 * because the question text differs — but an excerpt pulled twice is still an
 * exact duplicate line inside it, and dropping it is exactly as lossless as
 * dropping a duplicate paragraph.
 */
export function dedupeRepeatedBlocks(
  minimumBlockTokens = 24,
  countTokens: TokenCounter = approximateTokenCount,
): Reducer {
  return {
    id: "dedupe-repeated-blocks",
    version: "2",
    risk: "lossless",
    reduce: (text) => {
      // Split KEEPING the separators: a text in which nothing was dropped
      // must come back byte-identical, never re-joined with normalized
      // blank lines. Duplicate keys are byte-exact — "lossless" means two
      // blocks differing only in whitespace are different blocks (code and
      // YAML make whitespace meaningful). Fenced code blocks are never
      // deduped, at either granularity: a prompt may legitimately repeat a
      // fixture to compare, and whitespace inside a fence is content.
      const seen = new Set<string>();
      const notes: string[] = [];
      let dropped = false;

      const describe = (unit: string, tokens: number) =>
        `Dropped a repeated ${tokens}-token block beginning "${unit.trim().replace(/\s+/g, " ").slice(0, 60)}".`;

      // A block that is not itself a whole-block duplicate may still contain
      // one: split on single newlines (there are none of the \n{2,} runs the
      // outer split already pulled out, so every remaining newline is a lone
      // line break) and drop any line that exactly matches one already kept.
      const dedupeLines = (block: string): string => {
        if (block.includes("```") || !block.includes("\n")) return block;
        const lines = block.split(/(\n)/);
        let changed = false;
        const keptLines: string[] = [];
        for (let index = 0; index < lines.length; index += 2) {
          const line = lines[index]!;
          const separator = lines[index + 1] ?? "";
          const tokens = countTokens(line);
          if (line.trim() !== "" && tokens >= minimumBlockTokens && seen.has(line)) {
            dropped = true;
            changed = true;
            notes.push(describe(line, tokens));
            continue;
          }
          seen.add(line);
          keptLines.push(line, separator);
        }
        return changed ? keptLines.join("") : block;
      };

      const parts = text.split(/(\n{2,})/);
      const kept: string[] = [];
      for (let index = 0; index < parts.length; index += 2) {
        const block = parts[index]!;
        const separator = parts[index + 1] ?? "";
        const tokens = countTokens(block);
        if (block.trim() !== "" && !block.includes("```") &&
            tokens >= minimumBlockTokens && seen.has(block)) {
          dropped = true;
          notes.push(describe(block, tokens));
          continue;
        }
        seen.add(block);
        kept.push(dedupeLines(block), separator);
      }
      if (!dropped) return { text, notes: [] };
      return { text: kept.join(""), notes };
    },
  };
}

/**
 * Collapses redundant whitespace outside fenced and inline code, where layout is
 * meaningful. Individually small; free, and it compounds across every request.
 */
export function collapseWhitespace(): Reducer {
  return {
    id: "collapse-whitespace",
    version: "1",
    risk: "lossless",
    reduce: (text) => {
      const code: string[] = [];
      const masked = text.replace(CODE_FENCE, (match) => {
        code.push(match);
        return `@@MESHCODE${code.length - 1}@@`;
      });
      const squeezed = masked
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const restored = squeezed.replace(/@@MESHCODE(\d+)@@/g, (_match, index) => code[Number(index)]!);
      const notes = restored.length < text.length
        ? [`Collapsed ${text.length - restored.length} characters of redundant whitespace, preserving code blocks.`]
        : [];
      return { text: restored, notes };
    },
  };
}

/** Run reducers in order, reporting what each one saved. */
export function applyReducers(
  text: string,
  reducers: Reducer[],
  countTokens: TokenCounter = approximateTokenCount,
): { text: string; outcomes: ReductionOutcome[]; tokensBefore: number; tokensAfter: number } {
  const tokensBefore = countTokens(text);
  let current = text;
  const outcomes: ReductionOutcome[] = [];
  for (const reducer of reducers) {
    const before = countTokens(current);
    const result = reducer.reduce(current);
    const after = countTokens(result.text);
    if (after > before) {
      throw new Error(`Reducer ${reducer.id} increased token count from ${before} to ${after}.`);
    }
    outcomes.push({
      reducer: reducer.id,
      version: reducer.version,
      risk: reducer.risk,
      text: result.text,
      tokensBefore: before,
      tokensAfter: after,
      tokensSaved: before - after,
      notes: result.notes,
    });
    current = result.text;
  }
  return { text: current, outcomes, tokensBefore, tokensAfter: countTokens(current) };
}

export type PrefixBreaker = {
  /** What kind of per-request value is sitting inside the would-be stable prefix. */
  kind: "timestamp" | "date" | "uuid" | "long-number" | "unknown";
  example: string;
  occurrences: number;
};

export type CachingProjection =
  | {
    status: "priced";
    baselineCostUsd: number;
    cachedCostUsd: number;
    savingUsd: number;
    savingPercent: number;
    recoverableSavingUsd: number;
  }
  | { status: "unpriced"; reason: string };

export type CachingAnalysis = {
  requests: number;
  meanInputTokens: number;
  /** Tokens identical across every sampled request, from the start of the prompt. */
  sharedPrefixTokens: number;
  /** Share of a request's input that the provider could serve from cache today. */
  cacheablePrefixShare: number;
  /**
   * Shared prefix that would exist if the per-request values listed in
   * `prefixBreakers` were moved out of the prefix. The gap between this and
   * `sharedPrefixTokens` is the cost of a timestamp in a system prompt.
   */
  recoverablePrefixTokens: number;
  prefixBreakers: PrefixBreaker[];
  projection: CachingProjection;
};

const BREAKER_PATTERNS: Array<{ kind: PrefixBreaker["kind"]; pattern: RegExp }> = [
  { kind: "timestamp", pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g },
  { kind: "uuid", pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { kind: "date", pattern: /\d{4}-\d{2}-\d{2}/g },
  { kind: "long-number", pattern: /\b\d{6,}\b/g },
];

export function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Removes a repeated LEADING block from texts after the first, when that
 * block is an exact match for the start of the first text in the group.
 *
 * This is the shape a continuous-learning / continuous-memory agent
 * produces: the application glues the same memory or persistent-instruction
 * block to the front of every turn, with only a short turn-specific
 * remainder varying underneath it. `dedupeRepeatedBlocks` never catches
 * this, because it only ever sees one text at a time and the memory block
 * is not a standalone paragraph inside any single text - it is the shared
 * PREFIX of several texts that each continue differently.
 *
 * LOSSY, not lossless, unlike `dedupeRepeatedBlocks`: a same-text duplicate
 * sits right next to its twin, so the model reads both in the same breath.
 * The duplicate removed here can be many turns upstream of the current one,
 * which is a real behaviour change - a model that attends less to context
 * far back in a long history may act differently with the block restated
 * fresh every turn versus present once near the start. Callers must run
 * this behind a replay-gate pass on their own traffic before billing it;
 * it is never enabled by default.
 *
 * The cut point is always snapped to the last newline at or before the raw
 * common-prefix length (never cut THROUGH a line), unless the match is a
 * complete containment of one text inside the other, which needs no
 * snapping because there is no partially-matched line to protect. This
 * means a false positive - two texts that happen to start with the same
 * few words before diverging mid-line, e.g. two turns both opening "Turn "
 * - can only ever leave that differing line untouched, never truncate into it.
 */
export function dedupeRepeatedLeadingBlock(
  texts: readonly string[],
  minimumBlockTokens = 24,
  countTokens: TokenCounter = approximateTokenCount,
): { texts: string[]; notes: string[] } {
  if (texts.length === 0) return { texts: [], notes: [] };
  const canonical = texts[0]!;
  const notes: string[] = [];
  const nextTexts = texts.map((text, index) => {
    if (index === 0) return text;
    const raw = commonPrefixLength(canonical, text);
    if (raw === 0) return text;
    const fullContainment = raw === canonical.length || raw === text.length;
    let safe = raw;
    if (!fullContainment) {
      const lastNewline = text.lastIndexOf("\n", raw - 1);
      safe = lastNewline === -1 ? 0 : lastNewline + 1;
    }
    if (safe === 0) return text;
    const removed = text.slice(0, safe);
    if (removed.trim() === "" || removed.includes("```")) return text;
    const tokens = countTokens(removed);
    if (tokens < minimumBlockTokens) return text;
    notes.push(
      `Turn ${index + 1}: replaced a ${tokens}-token leading block identical to turn 1's opening with a ` +
        "reference marker.",
    );
    return `[mesh: ${tokens} tokens of this turn's leading context, identical to turn 1, omitted]${text.slice(safe)}`;
  });
  return { texts: nextTexts, notes };
}

export type RagCorpusCacheResult = {
  /** The corpus in its stable, append-only order after this call (identical to the input corpus when skipped). */
  corpus: string[];
  /** This request's chunks resolved to indices into `corpus`, in `chunks` order. Empty when skipped. */
  indices: number[];
  /** How many previously-unseen chunks this call added. */
  appended: number;
  /** True when adding this request's new chunks would have exceeded `maximumCorpusTokens`, so NOTHING was added — the corpus and `indices` are untouched/empty rather than half-updated. */
  skippedOverBudget: boolean;
};

/**
 * Grow an append-only, cache-stable corpus of retrieval chunks and resolve
 * this request's chunk list to stable indices into it.
 *
 * This is the lever behind `ragCorpusCache` (see reduce-request.ts):
 * Anthropic's own prompt-caching guidance is to put a whole retrieval corpus
 * under ~200K tokens in the cached prefix rather than caching per-query chunk
 * selections, because a provider's cache matches an EXACT prefix and a RAG
 * pipeline's per-query picks are themselves never byte-identical between two
 * different questions — even when most of the underlying text repeats, the
 * SET and ORDER of chunks a retriever returns varies per query, so inlining
 * picks fresh every time means the provider's cache never has a stable
 * prefix to match against. An append-only corpus, grown in first-seen order
 * and never reordered once written, stays a stable, growing prefix across
 * every request that reuses an already-seen chunk, so a later request pays
 * the cache-read rate on everything it repeats instead of full rate.
 *
 * Deliberately ALL-OR-NOTHING per call: if adding this request's new chunks
 * would push the corpus over `maximumCorpusTokens`, nothing is added and the
 * corpus is returned unchanged — never half of one request's chunks hoisted
 * and half left behind, which would be harder for a caller to audit than
 * simply "this one did not qualify."
 */
export function growRagCorpus(
  corpus: readonly string[],
  chunks: readonly string[],
  options: { maximumCorpusTokens?: number; countTokens?: TokenCounter } = {},
): RagCorpusCacheResult {
  const countTokens = options.countTokens ?? approximateTokenCount;
  const maximumCorpusTokens = options.maximumCorpusTokens ?? 8_000;
  const known = new Map<string, number>(corpus.map((text, index) => [text, index]));
  const newChunks: string[] = [];
  for (const chunk of chunks) {
    if (!known.has(chunk) && !newChunks.includes(chunk)) newChunks.push(chunk);
  }
  if (newChunks.length === 0) {
    return { corpus: [...corpus], indices: chunks.map((chunk) => known.get(chunk)!), appended: 0, skippedOverBudget: false };
  }
  const currentTokens = corpus.reduce((sum, text) => sum + countTokens(text), 0);
  const addedTokens = newChunks.reduce((sum, text) => sum + countTokens(text), 0);
  if (currentTokens + addedTokens > maximumCorpusTokens) {
    return { corpus: [...corpus], indices: [], appended: 0, skippedOverBudget: true };
  }
  const nextCorpus = [...corpus];
  for (const chunk of newChunks) {
    known.set(chunk, nextCorpus.length);
    nextCorpus.push(chunk);
  }
  return { corpus: nextCorpus, indices: chunks.map((chunk) => known.get(chunk)!), appended: newChunks.length, skippedOverBudget: false };
}

/** Render a grown corpus as the stable block placed in the cacheable prefix. */
export function renderRagCorpusBlock(corpus: readonly string[]): string {
  if (corpus.length === 0) return "";
  const items = corpus.map((text, index) => `[corpus#${index}] ${text}`).join("\n\n");
  return `RETRIEVAL CORPUS (cache-stable; an item's number does not imply it is relevant to the current question):\n${items}`;
}

function maskBreakers(text: string): { masked: string; found: Map<string, PrefixBreaker> } {
  let masked = text;
  const found = new Map<string, PrefixBreaker>();
  for (const { kind, pattern } of BREAKER_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      const existing = found.get(match);
      if (existing) existing.occurrences += 1;
      else found.set(match, { kind, example: match, occurrences: 1 });
      return `[[${kind}]]`;
    });
  }
  return { masked, found };
}

/**
 * How much of a workload's prompt a provider's prefix cache could serve, and what
 * is stopping it.
 *
 * Providers cache on an exact prefix match, so a single value that changes per
 * request invalidates everything after it. A current-date line at the top of a
 * system prompt can therefore cost the entire prompt's cache discount, which is
 * the difference between paying full input rate and one twentieth of it. That
 * failure is invisible in a cost dashboard: spend simply stays high.
 *
 * `requests` should be a representative sample of real prompts for one workload.
 */
export function analysePromptCaching(
  requests: string[],
  options: {
    price?: TokenPrice;
    countTokens?: TokenCounter;
    /** Minimum prefix a provider will cache at all; OpenAI's floor is 1024 tokens. */
    minimumCacheableTokens?: number;
  } = {},
): CachingAnalysis {
  if (requests.length < 2) {
    throw new Error("Prefix-cache analysis needs at least two requests to find what they share.");
  }
  const countTokens = options.countTokens ?? approximateTokenCount;
  const minimumCacheable = options.minimumCacheableTokens ?? 1024;

  const rawPrefix = requests.reduce((prefix, request) =>
    prefix.slice(0, commonPrefixLength(prefix, request)), requests[0]!);
  const masked = requests.map(maskBreakers);
  const maskedPrefix = masked.reduce((prefix, { masked: text }) =>
    prefix.slice(0, commonPrefixLength(prefix, text)), masked[0]!.masked);

  const breakers = new Map<string, PrefixBreaker>();
  for (const { found } of masked) {
    for (const [value, breaker] of found) {
      const existing = breakers.get(value);
      if (existing) existing.occurrences += breaker.occurrences;
      else breakers.set(value, { ...breaker });
    }
  }

  const sharedPrefixTokens = countTokens(rawPrefix);
  const recoverablePrefixTokens = countTokens(maskedPrefix);
  const meanInputTokens = requests.reduce((sum, request) => sum + countTokens(request), 0) / requests.length;

  // Only a prefix above the provider's floor caches at all.
  const effectivePrefix = sharedPrefixTokens >= minimumCacheable ? sharedPrefixTokens : 0;
  const effectiveRecoverable = recoverablePrefixTokens >= minimumCacheable ? recoverablePrefixTokens : 0;

  let projection: CachingProjection;
  if (!options.price) {
    projection = { status: "unpriced", reason: "No price was supplied, so only token counts are reported." };
  } else if (options.price.cachedInputPerMillion === undefined) {
    projection = {
      status: "unpriced",
      reason: "The supplied price has no cached-input rate, so a caching saving cannot be computed.",
    };
  } else {
    const price = options.price;
    const cost = (prefixTokens: number): number => {
      const body = Math.max(0, meanInputTokens - prefixTokens);
      // The first request populates the cache and the rest read it. Providers
      // charging a write premium (Anthropic) bill it once; providers without one
      // (OpenAI) just pay the normal input rate on that first call.
      const write = price.cacheWriteInputPerMillion === undefined
        ? estimateTokenCost(prefixTokens, 0, price)
        : estimateTokenCost(prefixTokens, 0, price, { cacheWriteInputTokens: prefixTokens });
      const read = estimateTokenCost(prefixTokens, 0, price, { cachedInputTokens: prefixTokens });
      const bodyCost = estimateTokenCost(body, 0, price);
      return write + (requests.length - 1) * read + requests.length * bodyCost;
    };
    const baselineCostUsd = estimateTokenCost(meanInputTokens, 0, price) * requests.length;
    const cachedCostUsd = effectivePrefix === 0 ? baselineCostUsd : cost(effectivePrefix);
    const recoverableCostUsd = effectiveRecoverable === 0 ? baselineCostUsd : cost(effectiveRecoverable);
    projection = {
      status: "priced",
      baselineCostUsd,
      cachedCostUsd,
      savingUsd: baselineCostUsd - cachedCostUsd,
      savingPercent: baselineCostUsd === 0 ? 0 : ((baselineCostUsd - cachedCostUsd) / baselineCostUsd) * 100,
      recoverableSavingUsd: Math.max(0, cachedCostUsd - recoverableCostUsd),
    };
  }

  return {
    requests: requests.length,
    meanInputTokens,
    sharedPrefixTokens,
    cacheablePrefixShare: meanInputTokens === 0 ? 0 : effectivePrefix / meanInputTokens,
    recoverablePrefixTokens,
    prefixBreakers: [...breakers.values()]
      .sort((left, right) => right.occurrences - left.occurrences)
      .slice(0, 20),
    projection,
  };
}

export type OutputCapAdvice = {
  observations: number;
  /** Cap that would have truncated none of the observed responses. */
  maxObserved: number;
  recommendedCap: number;
  /** Share of observed responses the recommended cap would have truncated. */
  truncationRate: number;
  meanOutputTokens: number;
  /**
   * Saving only materialises on responses that would have run past the cap, so
   * this is deliberately conservative: it counts the tokens above the cap and
   * nothing else.
   */
  projectedTokensSaved: number;
  projectedSavingUsd?: number;
};

/**
 * Recommend `max_output_tokens` from observed response lengths.
 *
 * Output is the expensive half of the bill (5x input on Sonnet 5.5, 8x on gpt-5),
 * and an uncapped request lets a model ramble at that rate. A cap set at a high
 * quantile of what a workload actually produces removes the tail without touching
 * the responses that were already the right length.
 *
 * This caps length; it does not make answers shorter at equal quality. Any
 * response that would have exceeded the cap gets truncated, so `truncationRate`
 * is the number to judge it on, and a cap belongs behind a replay check before
 * rollout.
 */
export function recommendOutputCap(
  observedOutputTokens: number[],
  options: { quantile?: number; price?: TokenPrice; headroom?: number } = {},
): OutputCapAdvice {
  if (observedOutputTokens.length === 0) {
    throw new Error("An output cap needs observed response lengths to be derived from.");
  }
  if (observedOutputTokens.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Observed output token counts must be non-negative finite numbers.");
  }
  const quantile = options.quantile ?? 0.99;
  if (quantile <= 0 || quantile > 1) throw new Error("quantile must be above 0 and at most 1.");
  const headroom = options.headroom ?? 1.1;
  if (headroom < 1) throw new Error("headroom must be at least 1.");

  const sorted = [...observedOutputTokens].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  const recommendedCap = Math.ceil(sorted[Math.max(0, index)]! * headroom);
  const truncated = sorted.filter((value) => value > recommendedCap);
  const projectedTokensSaved = truncated.reduce((sum, value) => sum + (value - recommendedCap), 0);
  const meanOutputTokens = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  return {
    observations: sorted.length,
    maxObserved: sorted[sorted.length - 1]!,
    recommendedCap,
    truncationRate: truncated.length / sorted.length,
    meanOutputTokens,
    projectedTokensSaved,
    ...(options.price
      ? { projectedSavingUsd: estimateTokenCost(0, projectedTokensSaved, options.price) }
      : {}),
  };
}

export type ReductionSaving = {
  inputTokensSaved: number;
  outputTokensSaved: number;
  savingUsd?: number;
};

/** Price a projected reduction. Returns tokens only when no price is supplied. */
export function priceReduction(
  inputTokensSaved: number,
  outputTokensSaved: number,
  price?: TokenPrice,
): ReductionSaving {
  if (inputTokensSaved < 0 || outputTokensSaved < 0) {
    throw new Error("Token savings cannot be negative.");
  }
  return {
    inputTokensSaved,
    outputTokensSaved,
    ...(price
      ? { savingUsd: estimateTokenCost(inputTokensSaved, outputTokensSaved, price) }
      : {}),
  };
}
