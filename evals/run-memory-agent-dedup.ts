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
 * Night's new-lever research: continuous-learning / continuous-memory
 * agents (founder mandate shape list, item 3).
 *
 *   node --import tsx evals/run-memory-agent-dedup.ts
 *
 * The shape: an application maintains a memory block (user preferences,
 * standing facts, a running checklist) and re-injects it, unchanged, at the
 * front of every user turn - this is exactly how frameworks with a
 * conversation-level "memory" concept (LangChain's ConversationBufferMemory,
 * mem0-style memory stores, a hand-rolled system/context block some teams
 * glue onto every call because their provider SDK has no separate memory
 * channel) actually wire the request. `evals/run-workload-matrix.ts`
 * already carries this shape as "memory agent" and flagged (see
 * docs/rnd/2026-10-22-workload-matrix-findings.md, finding 1) that none of
 * MESH's existing levers touch it: `duplicateContext` only ever dedupes
 * within ONE message's text, and the memory block is not its own paragraph
 * inside any single message - it is the shared PREFIX of many messages
 * that each continue differently. The shape's own system prompt is also
 * below the 1,024-token documented cacheable minimum, so the cache stamp
 * earns nothing here either: this lever is genuinely the shape's only
 * lever.
 *
 * This eval measures THREE arms, and keeps the lossy arm clearly
 * separate from the lossless stack, honestly:
 *
 *   A. raw            - no MESH at all, uncached (the measured default:
 *                        Anthropic's cache is opt-in).
 *   B. lossless stack - toolSchemas + duplicateContext + repairCachePrefix
 *                        + the 5m cache stamp. This is what
 *                        run-workload-matrix.ts already reports for this
 *                        shape: a near-zero win, by design, because none of
 *                        those levers reach a block repeated ACROSS
 *                        messages.
 *   C. B + crossTurnMemoryDedup (NEW, LOSSY) - replaces the memory block in
 *                        every later user turn with a short reference
 *                        marker, keeping turn 1's block and every turn's
 *                        own differing remainder verbatim (see
 *                        packages/core/src/token-reduction.ts,
 *                        dedupeRepeatedLeadingBlock). Reported separately
 *                        and labelled LOSSY because the duplicate removed
 *                        is never adjacent to its twin: a model that
 *                        attends less to context far back in a long
 *                        history may behave differently with the block
 *                        present once near the start versus restated fresh
 *                        every turn. This arm's saving is NOT claimed as a
 *                        qualified win - it is reported as a candidate that
 *                        needs a replay-gate pass on a customer's own
 *                        traffic (packages/sdk-js/src/replay-gate.ts)
 *                        before it may ever be billed.
 *
 * All figures are SIMULATOR-measured against catalogued prices, labelled so.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-10-19";
const priceLookup = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (priceLookup.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");
// Captured as its own const so a nested function closure (measureArm, below) keeps the
// narrowed "priced" type - a bare module-scope narrowing of `priceLookup` itself does not
// survive into a function body under --strict (TS2339), only caught once this file was
// added to the typecheck:evals script tonight.
const price = priceLookup.price;

const LOSSLESS: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(4);

const MEMORY_BLOCK =
  "AGENT MEMORY (persistent): user prefers metric units; deploy window is 14:00-16:00 UTC; the staging DB is " +
  "read-only on Fridays; incident 4312 root cause was a stale feature flag; the review checklist has 9 items; " +
  "always page the on-call before schema changes; escalation contact is the on-call rotation, not a named " +
  "individual; every schema change needs a rollback plan written before it ships. ".repeat(6);

const TURNS = 40;

/** Continuous-memory agent: the same memory block re-injected every turn, unchanged. */
function memoryAgentStream(): Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> {
  const stream: Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> = [];
  const history: AnyObject[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    history.push({ role: "user", content: `${MEMORY_BLOCK}\nTurn ${turn}: handle today's request ${turn}.` });
    stream.push({
      atSeconds: turn * 45,
      request: { model: "claude-sonnet-5-5", max_tokens: 500, system: PREAMBLE, messages: [...history] },
      outputTokens: 260,
    });
    history.push({ role: "assistant", content: `Noted. Turn ${turn} handled per memory.` });
  }
  return stream;
}

/**
 * Flatten a request to the text the provider actually hashes, for simulator
 * pricing. The provider hashes CONTENT, not MESH's own JSON framing or its
 * cache_control metadata (which is never a billed content token): a string
 * body is documented as equivalent to its single text block, and Anthropic
 * concatenates adjacent system text blocks with no inserted separator. The
 * cacheTtl lever can turn a string `system`/message content into an array
 * of blocks (see stampAnthropicCacheTtl in reduce-request.ts); flattening
 * must follow that shape or the stamped arm's prompt silently loses text.
 */
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
  // Raw arm: caching unavailable (Anthropic's opt-in default). Lossless/lossy
  // arms: the 5m stamp is part of LOSSLESS, so run the SAME simulator with
  // caching unavailable too - the stamp's own effect is reported by
  // run-workload-matrix.ts's breakpoint-exact pricer; this eval isolates the
  // NEW lever's token effect, which is what the cache can never reach here
  // (the shape's prefix is below the 1,024-token cacheable minimum).
  const priced = simulateCache(simRequests, ANTHROPIC_NO_CACHE, price, { countTokens: approximateTokenCount });
  const leverCounts = new Map<string, number>();
  for (const note of notes) leverCounts.set(note, (leverCounts.get(note) ?? 0) + 1);
  console.log(
    `${label.padEnd(28)} tokens ${tokensBefore.toString().padStart(9)} -> ${tokensAfter.toString().padStart(9)}  ` +
      `cost $${priced.totalCostUsd.toFixed(4)}  levers: ${[...leverCounts.entries()].map(([id, n]) => `${id}x${n}`).join(", ") || "none"}`,
  );
  return { costUsd: priced.totalCostUsd, tokensBefore, tokensAfter, notes };
}

console.log(`MESH new-lever research: continuous-memory agent, ${TURNS} turns, memory block re-injected every turn`);
console.log(`catalogued claude-sonnet-5-5 prices (${AT}); raw arm priced with caching unavailable throughout\n`);

const stream = memoryAgentStream();
const raw = measureArm("A. raw (no MESH)", stream, undefined);
const lossless = measureArm("B. lossless stack", stream, { ...LOSSLESS, cacheTtl: "5m" });
const withDedup = measureArm("C. B + crossTurnMemoryDedup", stream, {
  ...LOSSLESS,
  cacheTtl: "5m",
  crossTurnMemoryDedup: true,
});

const losslessVsRaw = ((raw.costUsd - lossless.costUsd) / raw.costUsd) * 100;
const dedupVsLossless = ((lossless.costUsd - withDedup.costUsd) / lossless.costUsd) * 100;
const dedupVsRaw = ((raw.costUsd - withDedup.costUsd) / raw.costUsd) * 100;

console.log("\n=== result ===");
console.log(`B vs A (lossless stack alone, QUALIFIED - no information removed): ${losslessVsRaw.toFixed(1)}%`);
console.log(`C vs B (crossTurnMemoryDedup's OWN incremental effect, LOSSY, candidate only): ${dedupVsLossless.toFixed(1)}%`);
console.log(`C vs A (full stack including the lossy lever, LOSSY, candidate only): ${dedupVsRaw.toFixed(1)}%`);
console.log(
  "\ncaveat: B is a qualified, lossless win - safe to publish as-is. C is NOT a qualified win: the saved bytes " +
    "are byte-identical to text already sent, but the duplicate removed is many turns upstream of the current " +
    "one rather than adjacent to its twin, which is a real behaviour-risk class MESH's own lossless/lossy line " +
    "does not wave through for free. C must be proven on a customer's own traffic through replayGate " +
    "(packages/sdk-js/src/replay-gate.ts) before any part of its saving may be billed. Reported honestly as a " +
    "measured candidate, not a claim.",
);

if (withDedup.costUsd >= lossless.costUsd) {
  console.log("\nWARNING: crossTurnMemoryDedup did not beat the lossless stack on this shape - a finding, not a failure.");
  process.exitCode = 1;
}
