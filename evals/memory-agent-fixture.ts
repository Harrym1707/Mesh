/**
 * Shared fixture for the continuous-memory agent shape (founder mandate
 * shape list, item 3: continuous-learning/memory agents re-injecting the
 * same memory block every turn).
 *
 * Used by TWO scripts that must agree on what the simulated agent does:
 *
 *   evals/run-memory-agent-dedup.ts            - measures crossTurnMemoryDedup's
 *                                                 TOKEN/COST effect (candidate, unbilled).
 *   evals/run-replay-gate-memory-dedup.ts       - the replay-gate verdict this night
 *                                                 adds: is the candidate SAFE to bill?
 *
 * The question the gate script answers, and this fixture exists to make
 * answerable at all: dedupeRepeatedLeadingBlock (packages/core/src/token-reduction.ts)
 * replaces a repeated memory block in a LATER turn with a short reference
 * marker, leaving the FIRST turn's copy (or, with `restateEveryTurns` set,
 * every Nth turn's copy) verbatim. The information is never deleted from the
 * conversation - it is still sitting in an earlier message in the same
 * growing history every request resends - but it moves further from the
 * turn that needs it. Whether that matters is a real behavioural question
 * (model recall over distance, "lost in the middle"), not a token-counting
 * one, which is exactly why this lever is lossy and gate-bound rather than
 * free to ship.
 *
 * HONESTY LABEL - read before trusting a number out of this file: there is
 * no real model in this harness. `simulateRecall` below is a DECLARED
 * MODELLING ASSUMPTION, not a measurement of any real model's long-context
 * recall: correct exactly when the nearest verbatim restatement of the
 * memory block is within `MEMORY_RECALL_HORIZON_TURNS` turns of the one
 * asking about it, wrong otherwise. The constant is a deliberately
 * ordinary, round number picked to give the gate something non-trivial to
 * discriminate on, not a number read off a benchmark. It exists to prove
 * the GATE MECHANISM draws the right line between an unbounded reference
 * (unsafe: distance grows without limit) and a periodically-bounded one
 * (safe: distance is capped) - exactly the role the freshcap gate's
 * simulated provider plays for the fresh-tool-result cap
 * (evals/run-replay-gate-freshcap.ts). Before any part of crossTurnMemoryDedup
 * may be billed, this simulated verdict must be replaced with a real one: a
 * replay-gate pass on the customer's own traffic, graded by their own
 * task-completion signal or an LLM judge comparing real model output both
 * ways, per docs/rnd/2026-10-25-NOTES.md's "what the next night should
 * try".
 */

import { approximateTokenCount } from "../packages/core/src/index.js";

export type AnyObject = Record<string, unknown>;

export const PREAMBLE =
  "You are a careful specialist agent on a production team. Follow the runbook: verify inputs, cite sources, " +
  "prefer small reversible steps, surface anything risky to the orchestrator, and keep outputs terse. ".repeat(4);

export const MEMORY_BLOCK =
  "AGENT MEMORY (persistent): user prefers metric units; deploy window is 14:00-16:00 UTC; the staging DB is " +
  "read-only on Fridays; incident 4312 root cause was a stale feature flag; the review checklist has 9 items; " +
  "always page the on-call before schema changes; escalation contact is the on-call rotation, not a named " +
  "individual; every schema change needs a rollback plan written before it ships. ".repeat(6);

export const TURNS = 40;

/**
 * Deliberately ordinary, undeclared-from-any-benchmark distance budget - see
 * the module honesty label above. Not a measured number.
 */
export const MEMORY_RECALL_HORIZON_TURNS = 5;

export type MemoryFact = { label: string; sentence: string; value: string };

/** Five distinct, independently-checkable facts, each a verbatim substring of MEMORY_BLOCK. */
export const MEMORY_FACTS: MemoryFact[] = [
  { label: "deploy-window", sentence: "deploy window is 14:00-16:00 UTC", value: "14:00-16:00 UTC" },
  { label: "staging-db-friday", sentence: "the staging DB is read-only on Fridays", value: "read-only" },
  {
    label: "incident-4312-cause",
    sentence: "incident 4312 root cause was a stale feature flag",
    value: "a stale feature flag",
  },
  { label: "checklist-size", sentence: "the review checklist has 9 items", value: "9 items" },
  { label: "escalation-contact", sentence: "escalation contact is the on-call rotation", value: "the on-call rotation" },
];
for (const fact of MEMORY_FACTS) {
  if (!MEMORY_BLOCK.includes(fact.sentence)) {
    throw new Error(`fixture bug: MEMORY_BLOCK does not contain fact sentence for '${fact.label}'`);
  }
}

/** The fact a given turn asks about: cycles through MEMORY_FACTS deterministically. */
export function factForTurn(turn: number): MemoryFact {
  return MEMORY_FACTS[turn % MEMORY_FACTS.length]!;
}

/**
 * Builds the Anthropic Messages-shaped request a continuous-memory agent
 * would send at `turn` (0-indexed): the full growing history, with the
 * memory block re-injected at the front of every user turn, each asking
 * about one fact in rotation. `priorAssistantReplies[t]` is turn t's
 * assistant reply (filler; the assistant's own wording never carries the
 * fact, matching how a real memory-agent transcript's past turns are fixed
 * data during a replay, not something this run re-generates).
 */
export function buildMemoryRequest(turn: number, priorAssistantReplies: readonly string[]): AnyObject {
  const messages: AnyObject[] = [];
  for (let t = 0; t <= turn; t += 1) {
    const fact = factForTurn(t);
    messages.push({
      role: "user",
      content: `${MEMORY_BLOCK}\nTurn ${t}: what is the ${fact.label.replace(/-/g, " ")}?`,
    });
    if (t < turn) {
      messages.push({ role: "assistant", content: priorAssistantReplies[t] ?? `Noted. Turn ${t} handled.` });
    }
  }
  return {
    model: "claude-sonnet-5-5",
    max_tokens: 300,
    system: PREAMBLE,
    messages,
    metadata: { turn },
  };
}

/** All TURNS requests, in turn order, each carrying the full history up to that turn. */
export function buildMemoryFixtureRequests(turns = TURNS): AnyObject[] {
  const replies: string[] = [];
  const requests: AnyObject[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    requests.push(buildMemoryRequest(turn, replies));
    replies.push(`Noted. Turn ${turn} handled.`);
  }
  return requests;
}

/**
 * Extract a message's leading text the same way reduce-request.ts's
 * `leadingText` does, so this fixture's recall check sees exactly what the
 * provider would have received - a plain string, or a leading
 * `{type: "text"}` block. Returns undefined for anything else (e.g. a
 * tool-result-carrying message), matching production.
 */
function leadingText(message: AnyObject): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content) && message.content.length > 0) {
    const first = message.content[0] as AnyObject | undefined;
    if (first && first.type === "text" && typeof first.text === "string") return first.text;
  }
  return undefined;
}

/**
 * The simulated recall model this module's honesty label describes.
 *
 * Scans the (possibly reduced) request's own user messages - what was
 * ACTUALLY sent, after whichever candidate config ran - for the nearest
 * turn at or before `turn` whose text still contains `fact.sentence`
 * verbatim. Returns that turn's distance from the asking turn, or
 * `undefined` if the sentence is not present anywhere in the request (a
 * fixture bug, since turn 0 always restates it).
 */
export function nearestRestatementDistance(request: AnyObject, turn: number, fact: MemoryFact): number | undefined {
  const messages = request.messages as AnyObject[];
  const userMessages = messages.filter((message) => message.role === "user");
  for (let t = Math.min(turn, userMessages.length - 1); t >= 0; t -= 1) {
    const text = leadingText(userMessages[t]!);
    if (text !== undefined && text.includes(fact.sentence)) return turn - t;
  }
  return undefined;
}

export type RecallOutcome = { correct: boolean; distance: number | undefined; fact: MemoryFact };

/** Declared-assumption recall verdict for one (reduced) request. See the module honesty label. */
export function simulateRecall(
  request: AnyObject,
  horizonTurns = MEMORY_RECALL_HORIZON_TURNS,
): RecallOutcome {
  const turn = Number((request.metadata as AnyObject).turn);
  const fact = factForTurn(turn);
  const distance = nearestRestatementDistance(request, turn, fact);
  return { correct: distance !== undefined && distance <= horizonTurns, distance, fact };
}

/** Deterministic simulated reply text: correct recalls state the value, failed recalls visibly do not. */
export function simulatedReplyText(outcome: RecallOutcome, turn: number): string {
  return outcome.correct
    ? `Checked the notes for turn ${turn}. Answer: ${outcome.fact.value}. Logged and ready for the next step.`
    : `I do not have that detail noted for turn ${turn} in what is in front of me right now. Flagging for review.`;
}

/** Rough token count of a built request's text, for this script's own cost reporting. */
export function approximateRequestTokens(request: AnyObject): number {
  const messages = request.messages as AnyObject[];
  const text = messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
  return approximateTokenCount(`${request.system as string}\n${text}`);
}
