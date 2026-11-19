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
 * Night's new-lever research: autonomous long-horizon agents, the "retry
 * loops" half of the founder mandate shape list (item 2 — "history growth,
 * repeated tool schemas, retry loops, runaway spend").
 *
 *   node --import tsx evals/run-retry-loop-dedup.ts
 *
 * The shape, grounded in how real tool-calling frameworks actually behave
 * (not invented): when a tool call fails, the client returns the failure as
 * a `tool_result` block (often `is_error: true`) back into history, and the
 * model is expected to see it as data and retry (Anthropic's own tool-use
 * docs: "the client catches the exception and returns the error message in
 * the tool_result"). Write-ups on real agent deployments (e.g. a widely
 * shared LangGraph/agent-loop post titled "why your agent retries the same
 * broken tool call forever", and a GitHub issue describing an agent that
 * "retried the same broken call without end") document the failure mode
 * this fixture targets: a transient error gets retried with the IDENTICAL
 * arguments, producing an IDENTICAL error body, more than once, before
 * either succeeding or the caller gives up — and because the Messages API
 * is stateless, the full history (including every one of those identical
 * failures) is resent on every subsequent turn for the rest of the
 * conversation. The usual advice ("cap retries", "compact history") treats
 * the SYMPTOM; this lever targets the byte-identical duplicate itself.
 *
 * `evals/run-workload-matrix.ts`'s own `autonomousAgent()` fixture already
 * gestures at retries, but glues the retry text into one user-authored
 * sentence inside a single message — not the real shape, which is a
 * separate `tool_use`/`tool_result` turn pair per attempt. This fixture
 * uses the real shape, and that distinction matters: neither existing
 * lossless lever reaches it. `duplicateContext` only ever dedupes within
 * ONE message's text, and a retry's duplicate `tool_result` is a different
 * message several turns away. `crossTurnMemoryDedup` only reads a turn's
 * LEADING TEXT block, and a `tool_result` is never that — it is its own
 * block type, inside a user-role "carrier" message that has no leading
 * text at all.
 *
 * Three arms, lossy kept honestly separate from lossless, same convention
 * as `evals/run-memory-agent-dedup.ts`:
 *
 *   A. raw            - no MESH, uncached (Anthropic's cache is opt-in).
 *   B. lossless stack - toolSchemas + duplicateContext + repairCachePrefix
 *                        + the 5m cache stamp. Reaches the general
 *                        growing-history cost (shared prefix caches fine)
 *                        but NOT the specific retry duplication, which
 *                        sits inside the UNIQUE tail of every request.
 *   C. B + crossTurnToolResultDedup (NEW, LOSSY) - replaces every retry's
 *                        failure body after the first with a short
 *                        reference marker. Reported as a measured
 *                        candidate, NOT a qualified win: per
 *                        packages/sdk-js/src/reduce-request.ts's own
 *                        documentation of the lever, the duplicate removed
 *                        is never adjacent to its twin, so this needs a
 *                        replayGate pass on a customer's own traffic
 *                        before any part of it may be billed — the exact
 *                        same debt `crossTurnMemoryDedup` carries today.
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

const PREAMBLE =
  "You are an autonomous migration agent working unattended overnight. Make small reversible changes, verify " +
  "each step before the next, log every tool call's outcome, and stop and page a human if the same step fails " +
  "more than a few times in a row. ".repeat(4);

const TOOLS = Array.from({ length: 6 }, (_, index) => ({
  name: `subsystem_${index}_call`,
  description:
    `Invoke subsystem ${index}'s migration endpoint for the current record batch. Idempotent: safe to retry ` +
    "with the same arguments. Returns a status object or raises a transient error for the caller to retry.",
  input_schema: { type: "object", properties: { batch: { type: "integer" }, recordId: { type: "string" } }, required: ["batch"] },
}));

/** The identical error body a transient failure returns, every time it recurs. */
const FAILURE_BODY =
  "Tool subsystem_3_call failed: transient 503 from the migration subsystem; no record was written, the batch " +
  "is unchanged, and the caller should retry with the same arguments once the subsystem recovers. The last " +
  "known-good checkpoint for this batch is unaffected. ".repeat(2);

const TURNS = 24;
/** Turns at which the call to subsystem 3 fails this many times before succeeding. */
const RETRY_SCHEDULE = new Map<number, number>([[4, 2], [9, 3], [15, 2], [20, 4]]);

/** One autonomous agent run: `TURNS` turns of real work, some with a retried tool call in between. */
function retryLoopStream(): Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> {
  const stream: Array<{ atSeconds: number; request: AnyObject; outputTokens: number }> = [];
  const history: AnyObject[] = [];
  let toolCallId = 0;

  const send = (atSeconds: number, outputTokens: number): void => {
    stream.push({
      atSeconds,
      request: { model: "claude-sonnet-5-5", max_tokens: 600, system: PREAMBLE, tools: TOOLS, messages: [...history] },
      outputTokens,
    });
  };

  for (let turn = 0; turn < TURNS; turn += 1) {
    const atSeconds = turn * 30;
    history.push({ role: "user", content: `Turn ${turn}: continue the migration run for batch ${turn}.` });
    send(atSeconds, 180);
    history.push({ role: "assistant", content: `Starting batch ${turn}: invoking subsystem_3_call.` });

    const failures = RETRY_SCHEDULE.get(turn) ?? 0;
    for (let attempt = 0; attempt < failures; attempt += 1) {
      toolCallId += 1;
      const id = `toolu_${toolCallId}`;
      history.push({
        role: "assistant",
        content: [{ type: "tool_use", id, name: "subsystem_3_call", input: { batch: turn } }],
      });
      send(atSeconds + attempt + 1, 60);
      history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: FAILURE_BODY, is_error: true }] });
      history.push({ role: "assistant", content: `Attempt ${attempt + 1} failed transiently; retrying with the same arguments.` });
    }
    toolCallId += 1;
    const finalId = `toolu_${toolCallId}`;
    history.push({ role: "assistant", content: [{ type: "tool_use", id: finalId, name: "subsystem_3_call", input: { batch: turn } }] });
    send(atSeconds + failures + 1, 60);
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: finalId, content: `Batch ${turn} migrated: 420 records written.` }] });
    history.push({ role: "assistant", content: `Batch ${turn} complete; files touched logged at step ${turn}.` });
  }
  return stream;
}

/**
 * Flatten a request to the text the provider actually hashes — see
 * `evals/run-memory-agent-dedup.ts`'s identical helper for why: cache_control
 * is metadata, never billed content, and a string body is documented as
 * equivalent to its single text block. Tool content blocks are flattened to
 * their `content`/`text`, matching how Anthropic renders a `tool_result`.
 */
function wire(request: AnyObject): string {
  const flattenContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
    return content
      .map((block) => {
        const b = block as AnyObject;
        if (b === null || typeof b !== "object") return JSON.stringify(block) ?? "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "tool_result") return `${b.tool_use_id}:${flattenContent(b.content)}`;
        if (b.type === "tool_use") return `${String(b.id)}:${b.name}:${JSON.stringify(b.input)}`;
        return JSON.stringify(block) ?? "";
      })
      .join("");
  };
  const system = typeof request.system === "string" ? request.system : flattenContent(request.system);
  const tools = JSON.stringify(request.tools) ?? "";
  const messages = (request.messages as unknown[])
    .map((m) => `${(m as AnyObject).role}:${flattenContent((m as AnyObject).content)}`)
    .join("\n");
  return `${system}\n${tools}\n${messages}`;
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
  // arms: priced the same way, isolating the lever's own token effect from
  // the cache's — run-workload-matrix.ts already reports the breakpoint-exact
  // cache figure for a comparable growing-history shape.
  const priced = simulateCache(simRequests, ANTHROPIC_NO_CACHE, price.price, { countTokens: approximateTokenCount });
  const leverCounts = new Map<string, number>();
  for (const note of notes) leverCounts.set(note, (leverCounts.get(note) ?? 0) + 1);
  console.log(
    `${label.padEnd(28)} tokens ${tokensBefore.toString().padStart(9)} -> ${tokensAfter.toString().padStart(9)}  ` +
      `cost $${priced.totalCostUsd.toFixed(4)}  levers: ${[...leverCounts.entries()].map(([id, n]) => `${id}x${n}`).join(", ") || "none"}`,
  );
  return { costUsd: priced.totalCostUsd, tokensBefore, tokensAfter, notes };
}

console.log(`MESH new-lever research: autonomous long-horizon agent, ${TURNS} turns, retried-tool-call shape`);
console.log(`catalogued claude-sonnet-5-5 prices (${AT}); every arm priced with caching unavailable throughout\n`);

const stream = retryLoopStream();
const raw = measureArm("A. raw (no MESH)", stream, undefined);
const lossless = measureArm("B. lossless stack", stream, { ...LOSSLESS, cacheTtl: "5m" });
const withDedup = measureArm("C. B + crossTurnToolResultDedup", stream, {
  ...LOSSLESS,
  cacheTtl: "5m",
  crossTurnToolResultDedup: true,
});

const losslessVsRaw = ((raw.costUsd - lossless.costUsd) / raw.costUsd) * 100;
const dedupVsLossless = ((lossless.costUsd - withDedup.costUsd) / lossless.costUsd) * 100;
const dedupVsRaw = ((raw.costUsd - withDedup.costUsd) / raw.costUsd) * 100;

console.log("\n=== result ===");
console.log(`B vs A (lossless stack alone, QUALIFIED - no information removed): ${losslessVsRaw.toFixed(1)}%`);
console.log(`C vs B (crossTurnToolResultDedup's OWN incremental effect, LOSSY, candidate only): ${dedupVsLossless.toFixed(1)}%`);
console.log(`C vs A (full stack including the lossy lever, LOSSY, candidate only): ${dedupVsRaw.toFixed(1)}%`);
console.log(
  "\ncaveat: B is a qualified, lossless win - safe to publish as-is. C is NOT a qualified win: the saved bytes " +
    "are byte-identical to text already sent, but the duplicate removed (an earlier retry's failure) is not " +
    "adjacent to the later occurrence it matches, which is the same behaviour-risk class crossTurnMemoryDedup " +
    "carries. C must be proven on a customer's own traffic through replayGate " +
    "(packages/sdk-js/src/replay-gate.ts) before any part of its saving may be billed. Reported honestly as a " +
    "measured candidate, not a claim.",
);

if (withDedup.costUsd >= lossless.costUsd) {
  console.log("\nWARNING: crossTurnToolResultDedup did not beat the lossless stack on this shape - a finding, not a failure.");
  process.exitCode = 1;
}
