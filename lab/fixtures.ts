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

export type Fixture = {
  id: string;
  description: string;
  evaluator: "exact_match" | "classification";
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

export function getFixture(id: string | undefined): Fixture | undefined {
  if (!id) return undefined;
  return FIXTURES[id];
}
