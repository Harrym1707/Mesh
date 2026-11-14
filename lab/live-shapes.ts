// Replicas of the request shapes behind the LIVE numbers.
//
// evals/run-live-agents.ts drove five agents through the real Anthropic API on
// 2026-10-26; the hash-chained spools it wrote (evals/live-exports-2026-10-26/)
// are the source of the one LIVE figure in docs/NUMBERS.md. That script cannot
// be imported — importing it would run it — so the two AGENTIC shapes it defines
// are replicated here, constant for constant, to study offline what the live
// run actually did. A test checks these strings still appear in the script, so
// a drift is caught rather than silently measured.

import type { MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";

type AnyObject = Record<string, unknown>;

/** The model the live Anthropic run used (see the spools' `model` field). */
export const LIVE_MODEL = "claude-sonnet-5-5";

export const LIVE_PREAMBLE = [
  "You are a careful assistant. Follow instructions precisely and never invent facts.",
  ...Array.from({ length: 30 }, (_, i) => `Operating rule ${i}: cite sources, escalate anything risky, keep answers tight.`),
].join("\n\n");

const LIVE_TOOLS = Array.from({ length: 12 }, (_, i) => ({
  name: `lookup_${i}`,
  description: `Look up records in subsystem ${i}. Use this for questions about topic ${i}. Returns a paginated list.`,
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
}));

export const LIVE_BIG_TOOL_RESULT = Array.from({ length: 20 }, (_, i) =>
  `Record ${i}: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.`).join(" ");

/**
 * The live coding agent: five turns, a clock that ticks EVERY turn at the head
 * of a string system prompt, twelve tools, a growing history of big tool results.
 */
export function liveCodingAgentRequests(): AnyObject[] {
  return Array.from({ length: 5 }, (_, turn) => ({
    model: LIVE_MODEL,
    system: `Current time: 2026-10-13T09:0${turn}:00Z\n${LIVE_PREAMBLE}`,
    tools: LIVE_TOOLS,
    messages: [
      ...Array.from({ length: turn }, (_, p) => [
        { role: "user", content: `Step ${p}: inspect account 100${p}.` },
        { role: "assistant", content: LIVE_BIG_TOOL_RESULT },
      ]).flat(),
      { role: "user", content: "Investigate account 1009 and summarise." },
    ],
    max_tokens: 2000,
  }));
}

/** The reduction the live coding agent ran with (Anthropic side: 5m stamp). */
export const LIVE_CODING_CONFIG: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
  historyCompaction: true,
  freshToolResultCap: { maximumTokens: 600 },
  cacheTtl: "5m",
};

/**
 * The live support chat: six single-turn requests from different users, each
 * shipping the same stable system prompt and the same twelve tools.
 */
export function liveSupportChatRequests(): AnyObject[] {
  return Array.from({ length: 6 }, (_, i) => ({
    model: LIVE_MODEL,
    system: LIVE_PREAMBLE,
    tools: LIVE_TOOLS,
    messages: [{ role: "user", content: `User ${i}: how do I reset my password?` }],
    max_tokens: 2000,
  }));
}

/** The reduction the live support chat ran with — note: NO cache stamp. */
export const LIVE_SUPPORT_CONFIG: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
  maxOutputTokens: 400,
};
