// Measurement fixtures for the lab.
//
// Each fixture is a small, self-contained set of request cases the Evaluator
// replays a candidate technique against. Fixtures are synthetic and
// Mesh-owned — they carry NO customer content, consistent with the lab's
// content-blind rule. They are shaped to exercise a specific reduction: the
// RAG fixture repeats retrieved passages (so deduplication has real,
// measurable work to do); the padded fixture carries redundant whitespace.
//
// A lossless reducer removes only bytes the model does not need (exact
// duplicates, redundant whitespace outside code), so the model's visible
// content is unchanged and its output is unchanged — which is why the expected
// output doubles as both the baseline and candidate answer in a replay. That
// is the honest basis of "lossless-first": quality is held by construction,
// and the gate still measures it.

export type FixtureCase = {
  id: string;
  /** The request text the technique is applied to. */
  input: string;
  /** The expected model answer (classification label / exact string). */
  expected: string;
  /** Input price used to turn token deltas into a cost delta. */
  inputPerMillionUsd: number;
};

import type { WorkloadShape } from "./types.js";

export type Fixture = {
  id: string;
  description: string;
  evaluator: "exact_match" | "classification";
  /** Which traffic vertical this fixture represents. */
  shape?: WorkloadShape;
  cases: FixtureCase[];
};

const RETRIEVED_PASSAGE = [
  "Passage A: The Mesh proxy sits in front of AI traffic and removes wasted",
  "tokens without changing a single reply. It keeps a tamper-evident ledger",
  "so the one-percent-of-savings fee can be recomputed by the customer.",
].join(" ");

const RETRIEVED_PASSAGE_B = [
  "Passage B: Theo is an async per-user optimiser that only ever tunes Mesh's",
  "own configuration. He never reads content and never slows a request; he",
  "publishes a new policy version and the proxy hot-reloads it.",
].join(" ");

/** A RAG prompt that includes the same retrieved passage several times. */
function ragPrompt(question: string): string {
  return [
    "You are a retrieval assistant. Answer the question using the context.",
    "",
    RETRIEVED_PASSAGE,
    "",
    RETRIEVED_PASSAGE_B,
    "",
    // Overlapping chunks re-send the same passage — the lossless win.
    RETRIEVED_PASSAGE,
    "",
    RETRIEVED_PASSAGE_B,
    "",
    RETRIEVED_PASSAGE,
    "",
    `Question: ${question}`,
  ].join("\n");
}

export const FIXTURES: Record<string, Fixture> = {
  "rag-duplicate-passages": {
    id: "rag-duplicate-passages",
    description:
      "RAG classification prompts whose retrieved context repeats passages three times (overlapping-chunk duplication).",
    evaluator: "classification",
    cases: [
      { id: "rag-1", input: ragPrompt("Does the Mesh fee depend on trusting Mesh?"), expected: "no", inputPerMillionUsd: 3 },
      { id: "rag-2", input: ragPrompt("Does Theo read customer content?"), expected: "no", inputPerMillionUsd: 3 },
      { id: "rag-3", input: ragPrompt("Can the customer recompute the invoice?"), expected: "yes", inputPerMillionUsd: 3 },
      { id: "rag-4", input: ragPrompt("Does Mesh change the model's reply?"), expected: "no", inputPerMillionUsd: 3 },
      { id: "rag-5", input: ragPrompt("Does Theo slow down requests?"), expected: "no", inputPerMillionUsd: 3 },
      { id: "rag-6", input: ragPrompt("Is the ledger tamper-evident?"), expected: "yes", inputPerMillionUsd: 3 },
      { id: "rag-7", input: ragPrompt("Does the proxy hot-reload policy?"), expected: "yes", inputPerMillionUsd: 3 },
      { id: "rag-8", input: ragPrompt("Does Theo tune the customer app?"), expected: "no", inputPerMillionUsd: 3 },
    ],
  },

  "padded-whitespace": {
    id: "padded-whitespace",
    description: "Prompts carrying redundant whitespace outside code blocks.",
    evaluator: "classification",
    cases: Array.from({ length: 6 }, (_unused, index) => ({
      id: `pad-${index + 1}`,
      input:
        `Classify the sentiment.    \n\n\n\n` +
        `   The    service    was     ${index % 2 === 0 ? "excellent" : "terrible"}   today.    \n\n\n` +
        `Answer with one word.`,
      expected: index % 2 === 0 ? "positive" : "negative",
      inputPerMillionUsd: 3,
    })),
  },
};

// A prompt whose tool result is a pretty-printed JSON blob — the shape agent
// loops carry all the time. Minifying the JSON is lossless to the model.
function jsonToolPrompt(status: string): string {
  const body = JSON.stringify(
    {
      request: { method: "GET", path: "/v1/orders", retries: 0 },
      response: {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store", "x-request-id": "abc-123" },
        items: [
          { id: 1, state: "open", total: 42.5, currency: "USD", note: "priority" },
          { id: 2, state: "closed", total: 11.0, currency: "USD", note: "standard" },
          { id: 3, state: "open", total: 7.25, currency: "USD", note: "standard" },
        ],
      },
    },
    null,
    2,
  );
  return [
    "You are a monitoring assistant. Here is the latest tool result:",
    "",
    "```json",
    body,
    "```",
    "",
    "Did the request succeed? Answer yes or no.",
  ].join("\n");
}

FIXTURES["json-tool-results"] = {
  id: "json-tool-results",
  description: "Agent prompts carrying pretty-printed JSON tool results in fenced json blocks.",
  evaluator: "classification",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `json-${index + 1}`,
    input: jsonToolPrompt(index % 2 === 0 ? "200 OK" : "500 Error"),
    expected: index % 2 === 0 ? "yes" : "no",
    inputPerMillionUsd: 3,
  })),
};

// --- Agentic fixtures -----------------------------------------------------

// A realistic agent tool catalogue carrying JSON-Schema plumbing ($schema/$id/
// $comment) and titles that merely restate the property name — all of which the
// model never reads, so stripping them is lossless. This is the autonomous-agent
// shape: tool schemas are a big share of every cold/cache-miss turn.
function toolCatalogue(index: number): string {
  const tool = (name: string, desc: string) => ({
    type: "function",
    function: {
      name,
      description: desc,
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: `https://tools.example.com/${name}.json`,
        $comment: "Generated by the framework tool exporter; do not edit by hand.",
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", title: "query", description: "The search query string." },
          limit: { type: "integer", title: "limit", description: "Maximum results to return." },
          filter: { type: "string", title: "filter", description: "Optional filter expression." },
        },
        required: ["query"],
      },
    },
  });
  return JSON.stringify([
    tool("search", `Full-text search over the corpus (variant ${index}).`),
    tool("fetch", "Fetch a document by id."),
    tool("summarize", "Summarize a document into bullet points."),
    tool("rank", "Rank candidate passages by relevance."),
  ]);
}

FIXTURES["agent-tool-schemas"] = {
  id: "agent-tool-schemas",
  description: "Autonomous-agent tool catalogues carrying JSON-Schema plumbing and redundant titles the model never reads.",
  evaluator: "classification",
  shape: "autonomous-agent",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `tools-${index + 1}`,
    input: toolCatalogue(index),
    expected: "search", // the tool the model selects — unchanged by lossless compaction
    inputPerMillionUsd: 3,
  })),
};

// An always-on agent re-sends the same large system+tools prefix every turn,
// with only a short new user message appended. The re-sent prefix is exact
// duplicate content across the serialized request — lossless to drop.
const AGENT_PREFIX = [
  "SYSTEM: You are a long-running monitoring agent. Follow the operating rules.",
  "TOOLS: search(query), fetch(id), summarize(doc), rank(passages), alert(level,message).",
  "RULES: never fabricate; cite tool results; escalate only on confirmed anomalies;",
  "keep a running incident log; prefer cached reads; respect rate limits at all times.",
].join("\n");

function alwaysOnTurn(turnQuestion: string): string {
  return [
    AGENT_PREFIX,
    "",
    "TURN 1 USER: begin monitoring the orders service.",
    AGENT_PREFIX,
    "",
    "TURN 2 USER: any anomalies in the last hour?",
    AGENT_PREFIX,
    "",
    `TURN 3 USER: ${turnQuestion}`,
  ].join("\n");
}

FIXTURES["agent-history-resend"] = {
  id: "agent-history-resend",
  description: "Always-on agent turns that re-send the same large system+tools prefix every round (exact-duplicate history).",
  evaluator: "classification",
  shape: "always-on-agent",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `turn-${index + 1}`,
    input: alwaysOnTurn(index % 2 === 0 ? "is the service healthy?" : "should we escalate?"),
    expected: index % 2 === 0 ? "healthy" : "escalate",
    inputPerMillionUsd: 3,
  })),
};

export function getFixture(id: string | undefined): Fixture | undefined {
  if (!id) return undefined;
  return FIXTURES[id];
}
