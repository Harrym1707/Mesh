/**
 * Shared fixture for the memory-agent `crossTurnMemoryDedup` replay gate
 * (`run-replay-gate-memory-dedup.ts`).
 *
 * `evals/run-memory-agent-dedup.ts` (2026-10-23) measured a 58.0% token/cost
 * candidate for `crossTurnMemoryDedup` but could not grade it: that fixture's
 * turns never ask anything the memory block's content actually answers, so
 * there is nothing to grade right or wrong. This fixture repairs that: every
 * turn asks about ONE specific fact drawn from the memory block, so a grader
 * can ask "is the fact this turn needs actually recoverable from the request
 * MESH sent?" instead of only "are the bytes identical?".
 *
 * What this fixture can and cannot prove, stated plainly:
 *
 *   `crossTurnMemoryDedup` never deletes the fact - turn 1's copy of the
 *   memory block is always left verbatim (see `dedupeRepeatedLeadingBlock`
 *   in packages/core/src/token-reduction.ts). So the fact is ALWAYS present
 *   somewhere in the request, in every arm, and a presence-only grader (the
 *   house's existing `exactTextGrader` / `toolSelectionGrader` style) would
 *   pass every arm vacuously - it would say nothing about the actual risk
 *   this lever's own doc comment names: "a model that attends less to
 *   context far back in a long history may act differently with the block
 *   present once near the start versus restated fresh every turn."
 *
 *   There is no live API budget or customer traffic in this environment
 *   (same constraint every night since 2026-10-23 has recorded), so this
 *   fixture cannot call a real model and observe real attention decay. What
 *   it does instead: it scores each request by WHERE the needed fact ends
 *   up sitting in the final prompt MESH actually sent, and converts that
 *   position into a continuous "modeled recall probability" via
 *   `recallProbability()` below - a toy curve inspired by the qualitative
 *   SHAPE long-context recall studies report (near-ceiling when the needed
 *   fact is immediately before the question; a primacy plateau, clearly
 *   below ceiling and mildly eroding as the whole transcript grows, when the
 *   fact instead sits pinned at the very head of a growing conversation,
 *   which is exactly where `crossTurnMemoryDedup` leaves it after turn 1).
 *   The constants are NOT calibrated to any specific provider or model and
 *   must never be read as a measured number, published, or used to justify
 *   enabling the lever on real traffic. They exist so the replay-gate
 *   machinery (bootstrap bound, quality budget) has a non-vacuous, honestly
 *   labelled signal to run against until a real LLM-judge or a customer's
 *   own traffic can replace it - the thing `2026-10-23-NOTES.md` left owed.
 */

import { approximateTokenCount } from "../packages/core/src/index.js";

export type AnyObject = Record<string, unknown>;

/** Eight distinguishable, independently-searchable facts - the memory block's payload. */
export const FACTS: readonly string[] = [
  "the deploy window is 14:00-16:00 UTC",
  "the staging DB is read-only on Fridays",
  "incident 4312's root cause was a stale feature flag",
  "the review checklist has 9 items",
  "always page the on-call before schema changes",
  "the escalation contact is the on-call rotation, not a named individual",
  "every schema change needs a rollback plan written before it ships",
  "the user prefers metric units",
];

const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(4);

/** The re-injected memory block: a fixed preamble plus every fact, in order. */
export const MEMORY_BLOCK = `AGENT MEMORY (persistent): ${FACTS.join("; ")}.`;

export const TASKS = 30;
export const TURNS_PER_TASK = 8;

export type FixtureRequest = {
  request: AnyObject;
  taskIndex: number;
  turn: number;
  requiredFact: string;
};

/** Deterministic task -> starting-fact offset, so tasks don't all ask about fact 0 first. */
function factIndexFor(taskIndex: number, turn: number): number {
  return (taskIndex + turn) % FACTS.length;
}

/**
 * All TASKS x TURNS_PER_TASK fixture requests, one independent memory-agent
 * conversation per task, growing history exactly like a real continuous-
 * memory agent: the memory block re-injected at the front of every user
 * turn, each turn asking about a specific fact.
 */
export function buildFixtureRequests(): FixtureRequest[] {
  const out: FixtureRequest[] = [];
  for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
    const history: AnyObject[] = [];
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      const factIndex = factIndexFor(taskIndex, turn);
      const requiredFact = FACTS[factIndex]!;
      history.push({
        role: "user",
        content: `${MEMORY_BLOCK}\nTurn ${turn}: what should I do about fact ${factIndex}? Answer using the memory.`,
      });
      out.push({
        request: {
          model: "claude-sonnet-5-5",
          max_tokens: 300,
          system: PREAMBLE,
          messages: [...history],
          // Passed through untouched by reduceRequest (see run-replay-gate-freshcap.ts's
          // own metadata convention) so the grader can identify a reduced request without
          // relying on object identity, which reduceRequest does not preserve.
          metadata: { taskIndex, turn, requiredFact },
        },
        taskIndex,
        turn,
        requiredFact,
      });
      history.push({ role: "assistant", content: `Noted fact ${factIndex} for turn ${turn}.` });
    }
  }
  return out;
}

/**
 * Flatten a request to the text a provider would actually read, handling
 * both plain-string and array-of-text-block `system`/message content (the
 * shape some MESH levers can produce). Mirrors the flattener in
 * `run-memory-agent-dedup.ts` and `run-workload-matrix.ts`'s own `wire()`.
 */
export function flattenPrompt(request: AnyObject): string {
  const flattenContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const texts: string[] = [];
    for (const block of content) {
      const b = block as AnyObject;
      if (b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return texts.join("");
  };
  const systemText = flattenContent(request.system);
  const messages = (request.messages as unknown[] | undefined) ?? [];
  const messageText = messages
    .map((message) => flattenContent((message as AnyObject).content))
    .join("\n");
  return `${systemText}\n${messageText}`;
}

export type RecallEstimate = {
  /** Token distance from the end of the fact's last mention to the end of the prompt. */
  distanceTokens: number;
  /** Total prompt size, for the primacy-erosion term. */
  totalTokens: number;
  /** Modeled probability in [0, 1]; see the module doc comment for what this is and is not. */
  recallProbability: number;
  /** Whether the fact text was found in the prompt at all. */
  found: boolean;
};

const ADJACENT_THRESHOLD_TOKENS = 150;
const ADJACENT_CEILING = 0.985;
const PRIMACY_BASE = 0.93;
const PRIMACY_DECAY_PER_1K_TOTAL_TOKENS = 0.02;
const PRIMACY_FLOOR = 0.55;

/**
 * Toy, explicitly-uncalibrated recall-probability curve. See the module doc
 * comment: this is a labelled proxy for the SHAPE of published long-context
 * recall-decay findings, not a measurement of any real model.
 */
export function recallProbability(distanceTokens: number, totalTokens: number): number {
  if (distanceTokens <= ADJACENT_THRESHOLD_TOKENS) return ADJACENT_CEILING;
  const eroded = PRIMACY_BASE - PRIMACY_DECAY_PER_1K_TOTAL_TOKENS * (totalTokens / 1000);
  return Math.max(PRIMACY_FLOOR, eroded);
}

/**
 * Locate a fact's LAST occurrence in the prompt (the most recent, and so the
 * most favourably-attended, copy - every arm gets this same most-favourable
 * reading) and convert its position into a modeled recall estimate.
 */
export function estimateRecall(prompt: string, fact: string): RecallEstimate {
  const index = prompt.lastIndexOf(fact);
  if (index === -1) return { distanceTokens: Number.POSITIVE_INFINITY, totalTokens: 0, recallProbability: 0, found: false };
  const tail = prompt.slice(index + fact.length);
  const distanceTokens = approximateTokenCount(tail);
  const totalTokens = approximateTokenCount(prompt);
  return { distanceTokens, totalTokens, recallProbability: recallProbability(distanceTokens, totalTokens), found: true };
}
