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
    cases: Array.from({ length: 8 }, (_unused, index) => ({
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

// --- Chat & coding (the biggest token-billed consumer workloads) ----------

// Conversational chat where the framework echoes the full system prompt into
// the first user turn — a real, documented pattern. The echo is an exact
// duplicate block, so dropping it is lossless.
const CHAT_SYSTEM = [
  "You are a helpful, concise assistant. Be accurate and cite sources when asked.",
  "Never invent facts. If unsure, say so. Keep answers short unless detail is requested.",
  "Follow the user's formatting requests and remember the conversation so far.",
].join("\n");

function chatPrompt(question: string): string {
  return [
    CHAT_SYSTEM,
    "",
    // The framework re-states the system prompt inside the first user message.
    `USER: (system reminder) ${CHAT_SYSTEM}`,
    "",
    "ASSISTANT: Understood.",
    "",
    `USER: ${question}`,
  ].join("\n");
}

FIXTURES["chat-conversation"] = {
  id: "chat-conversation",
  description: "Multi-turn chat where the system prompt is echoed into the first user turn (exact-duplicate block).",
  evaluator: "classification",
  shape: "always-on-agent",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `chat-${index + 1}`,
    input: chatPrompt(index % 2 === 0 ? "Is the sky blue? yes or no." : "Is coal renewable? yes or no."),
    expected: index % 2 === 0 ? "yes" : "no",
    inputPerMillionUsd: 3,
  })),
};

// A coding agent that re-reads the same file into context across turns. The
// file body is plain text (not fenced), so the exact-duplicate re-read is a
// lossless drop.
const CODE_FILE = [
  "FILE src/orders.py:",
  "def total(order): return sum(i.price * i.qty for i in order.items)",
  "def is_paid(order): return order.status == 'paid' and order.balance == 0",
  "def summary(order): return {'id': order.id, 'total': total(order), 'paid': is_paid(order)}",
].join("\n");

function codingPrompt(task: string): string {
  // Realistic coding-agent turn: the file is re-read into context (exact
  // duplicate → dedup), a test tool returns pretty-printed JSON (→ JSON minify),
  // and the whole thing carries layout whitespace (→ collapse).
  const testResult = JSON.stringify(
    {
      passed: 3,
      failed: 1,
      duration_ms: 142,
      cases: [
        { name: "test_total", status: "passed" },
        { name: "test_is_paid", status: "failed", error: "AssertionError: balance not zero" },
        { name: "test_summary", status: "passed" },
      ],
    },
    null,
    2,
  );
  return [
    "You are a coding agent. Use the file context to answer.",
    "",
    CODE_FILE,
    "",
    "TOOL read_file(src/orders.py) ->",
    CODE_FILE,
    "",
    "TOOL run_tests() ->",
    "```json",
    testResult,
    "```",
    "",
    `TASK: ${task}`,
  ].join("\n");
}

FIXTURES["coding-agent"] = {
  id: "coding-agent",
  description: "Coding-agent turns that re-read the same file into context (exact-duplicate plain-text block).",
  evaluator: "classification",
  shape: "autonomous-agent",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `code-${index + 1}`,
    input: codingPrompt(
      index % 2 === 0 ? "Does total() sum line items? yes or no." : "Is an unpaid order is_paid()? yes or no.",
    ),
    expected: index % 2 === 0 ? "yes" : "no",
    inputPerMillionUsd: 3,
  })),
};

// --- Cache sessions (the prefix-caching lever's target) -------------------
// A steady-state request: a large STABLE prefix (system + tools, cached across
// the session) separated by a blank line from a short fresh suffix. The cache
// lever bills the prefix at the read rate. Prefix dominates, as it does in
// real long-running agents and long-system-prompt chats.

const AGENT_SESSION_PREFIX = [
  "SYSTEM: You are a long-running operations agent. Operate strictly by the rules below.",
  "You coordinate monitoring, triage and escalation across the orders, billing and inventory services.",
  "RULES: never fabricate; always cite the tool result that supports a claim; escalate only confirmed anomalies;",
  "keep a running incident log; prefer cached reads; respect provider rate limits; summarize before escalating;",
  "redact customer identifiers; never take destructive actions without an explicit confirmed instruction.",
  "TOOLS: search(query), fetch(id), summarize(doc), rank(passages), diff(a,b), alert(level,message), log(entry).",
  "TOOL SCHEMAS: search -> {query:string, limit?:int}; fetch -> {id:string}; summarize -> {doc:string};",
  "rank -> {passages:string[]}; diff -> {a:string, b:string}; alert -> {level:enum, message:string}; log -> {entry:string}.",
].join("\n");

const CHAT_SESSION_PREFIX = [
  "You are a careful, friendly assistant for a productivity app. Keep answers short and correct.",
  "House style: plain language, no hedging, cite sources when asked, never invent facts, admit uncertainty.",
  "You remember the whole conversation, follow the user's formatting requests, and keep a consistent persona.",
  "Safety: decline harmful requests briefly; do not give medical, legal or financial advice beyond general info.",
].join("\n");

function sessionCase(prefix: string, suffix: string): string {
  return `${prefix}\n\n${suffix}`;
}

FIXTURES["agent-session"] = {
  id: "agent-session",
  description: "Always-on/autonomous agent requests with a large stable system+tools prefix cached across the session.",
  evaluator: "classification",
  shape: "always-on-agent",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `sess-${index + 1}`,
    input: sessionCase(
      AGENT_SESSION_PREFIX,
      [
        index % 2 === 0 ? "USER: is the orders service healthy right now?" : "USER: should we escalate the billing incident?",
        "TOOL fetch(orders/status) -> error_rate=4.2%, p95_latency_ms=820, window=15m, degraded=true",
        "TOOL diff(baseline,current) -> error_rate +3.1pp, latency +300ms; inventory nominal; billing nominal",
        "TOOL log(entry) -> appended incident note #4471 to the running session log",
        "Assess the tool results and answer in exactly one word.",
      ].join("\n"),
    ),
    expected: index % 2 === 0 ? "healthy" : "escalate",
    inputPerMillionUsd: 3,
  })),
};

FIXTURES["chat-session"] = {
  id: "chat-session",
  description: "Chat requests with a stable system prompt cached across the conversation and a short fresh user turn.",
  evaluator: "classification",
  shape: "always-on-agent",
  cases: Array.from({ length: 8 }, (_unused, index) => ({
    id: `csess-${index + 1}`,
    input: sessionCase(
      CHAT_SESSION_PREFIX,
      [
        "ASSISTANT: Earlier I helped you draft the Q3 summary, set three reminders, and outline the deck.",
        "USER: thanks, that was useful. I have a couple more follow-ups after this.",
        "ASSISTANT: Of course — go ahead.",
        index % 2 === 0 ? "USER: quick factual check: is water wet? answer yes or no." : "USER: quick factual check: is fire cold? answer yes or no.",
      ].join("\n"),
    ),
    expected: index % 2 === 0 ? "yes" : "no",
    inputPerMillionUsd: 3,
  })),
};

export function getFixture(id: string | undefined): Fixture | undefined {
  if (!id) return undefined;
  return FIXTURES[id];
}
