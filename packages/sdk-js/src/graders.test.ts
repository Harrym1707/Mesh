import { describe, expect, it } from "vitest";
import {
  agentGrader,
  compositeGrader,
  taskCompletionGrader,
  textSimilarityGrader,
  truncationAwareGrader,
} from "./graders.js";

function text(value: string, extra: Record<string, unknown> = {}): unknown {
  return { output_text: value, ...extra };
}

function toolCall(name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    output: [{ type: "function_call", name, arguments: '{"accountId":"1"}' }],
    ...extra,
  };
}

const SENTENCE = Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ");
const firstHalf = SENTENCE.split(" ").slice(0, 50).join(" ");
const firstNinety = SENTENCE.split(" ").slice(0, 90).join(" ");

describe("textSimilarityGrader", () => {
  it("scores an identical answer as a full match", () => {
    expect(textSimilarityGrader({
      request: {}, baselineResponse: text(SENTENCE), candidateResponse: text(SENTENCE),
    })).toBe(1);
  });

  it("scores a disjoint answer as a total miss", () => {
    expect(textSimilarityGrader({
      request: {}, baselineResponse: text("alpha beta"), candidateResponse: text("gamma delta"),
    })).toBe(0);
  });

  it("scores a mostly-complete answer high rather than failing it", () => {
    // The behaviour the binary grader got wrong: 90% of the content is worth
    // about 0.95, not 0.
    const score = Number(textSimilarityGrader({
      request: {}, baselineResponse: text(SENTENCE), candidateResponse: text(firstNinety),
    }));
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });

  it("degrades as more of the answer is lost", () => {
    const ninety = Number(textSimilarityGrader({
      request: {}, baselineResponse: text(SENTENCE), candidateResponse: text(firstNinety),
    }));
    const half = Number(textSimilarityGrader({
      request: {}, baselineResponse: text(SENTENCE), candidateResponse: text(firstHalf),
    }));
    expect(half).toBeLessThan(ninety);
  });

  it("treats two empty answers as equivalent and one empty as a miss", () => {
    expect(textSimilarityGrader({ request: {}, baselineResponse: text(""), candidateResponse: text("") })).toBe(1);
    expect(textSimilarityGrader({
      request: {}, baselineResponse: text(SENTENCE), candidateResponse: text(""),
    })).toBe(0);
  });
});

describe("truncationAwareGrader", () => {
  const grade = truncationAwareGrader();

  it("passes an answer the provider did not cut off", () => {
    expect(grade({
      request: {},
      baselineResponse: text(SENTENCE),
      candidateResponse: text(firstHalf, { finish_reason: "stop" }),
    })).toBe(1);
  });

  it("scores a cut-off answer by how much of it survived", () => {
    const score = Number(grade({
      request: {},
      baselineResponse: text(SENTENCE),
      candidateResponse: text(firstNinety, { finish_reason: "length" }),
    }));
    // 90% coverage less the small penalty for being visibly incomplete.
    expect(score).toBeCloseTo(0.85, 2);
  });

  it("fails an answer cut off too early to be useful", () => {
    const quarter = SENTENCE.split(" ").slice(0, 25).join(" ");
    expect(grade({
      request: {},
      baselineResponse: text(SENTENCE),
      candidateResponse: text(quarter, { finish_reason: "length" }),
    })).toBe(0);
  });

  it("recognises every provider's way of saying it ran out of room", () => {
    for (const marker of [
      { finish_reason: "length" },
      { stop_reason: "max_tokens" },
      { incomplete_details: { reason: "max_output_tokens" } },
      { choices: [{ finish_reason: "length" }] },
    ]) {
      const score = Number(grade({
        request: {},
        baselineResponse: text(SENTENCE),
        candidateResponse: { output_text: firstNinety, ...marker },
      }));
      expect(score).toBeLessThan(1);
    }
  });

  it("validates its options", () => {
    expect(() => truncationAwareGrader({ uselessBelowCoverage: 2 })).toThrow(/between 0 and 1/);
    expect(() => truncationAwareGrader({ truncationPenalty: -1 })).toThrow(/between 0 and 1/);
  });
});

describe("compositeGrader", () => {
  it("takes a weighted mean of its parts", async () => {
    const grade = compositeGrader([
      { grader: () => 1, weight: 3 },
      { grader: () => 0, weight: 1 },
    ]);
    await expect(grade({ request: {}, baselineResponse: {}, candidateResponse: {} })).resolves.toBeCloseTo(0.75, 6);
  });

  it("clamps a part that returns something out of range", async () => {
    const grade = compositeGrader([{ grader: () => 5, weight: 1 }]);
    await expect(grade({ request: {}, baselineResponse: {}, candidateResponse: {} })).resolves.toBe(1);
  });

  it("rejects an empty or badly weighted composition", () => {
    expect(() => compositeGrader([])).toThrow(/at least one part/);
    expect(() => compositeGrader([{ grader: () => 1, weight: 0 }])).toThrow(/positive finite/);
  });
});

describe("agentGrader", () => {
  const grade = agentGrader();

  it("fails outright when the tool choice changed, however good the prose", async () => {
    // A different tool is a different action taken in the world.
    await expect(grade({
      request: {},
      baselineResponse: toolCall("lookup_refunds", { output_text: SENTENCE }),
      candidateResponse: toolCall("lookup_payouts", { output_text: SENTENCE }),
    })).resolves.toBe(0);
  });

  it("passes a matching tool choice with a complete answer", async () => {
    await expect(grade({
      request: {},
      baselineResponse: toolCall("lookup_refunds"),
      candidateResponse: toolCall("lookup_refunds"),
    })).resolves.toBe(1);
  });

  it("scores by completeness when the tool matched but the answer was cut", async () => {
    const score = await grade({
      request: {},
      baselineResponse: toolCall("lookup_refunds", { output_text: SENTENCE }),
      candidateResponse: toolCall("lookup_refunds", { output_text: firstNinety, finish_reason: "length" }),
    });
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(1);
  });

  it("falls back to completeness when no tools were involved at all", async () => {
    await expect(grade({
      request: {},
      baselineResponse: text(SENTENCE),
      candidateResponse: text(SENTENCE, { finish_reason: "stop" }),
    })).resolves.toBe(1);
  });
});

describe("taskCompletionGrader", () => {
  // A response carrying any number of tool calls, plus optional answer text.
  const resp = (calls: Array<[string, string?]>, answer?: string): unknown => ({
    output: calls.map(([name, args]) => ({ type: "function_call", name, arguments: args ?? '{"accountId":"1"}' })),
    ...(answer === undefined ? {} : { output_text: answer }),
  });

  it("scores 1 when the candidate reproduced the baseline's action", () => {
    expect(taskCompletionGrader()({ request: {}, baselineResponse: resp([["lookup_7"]]), candidateResponse: resp([["lookup_7"]]) })).toBe(1);
  });

  it("tolerates an EXTRA exploratory call — where toolSelectionGrader would penalise it", () => {
    // The point of the lever's gate: a search detour that still did the needed
    // call completed the task. Recall of the baseline's one call is 1.
    const comparison = { request: {}, baselineResponse: resp([["lookup_7"]]), candidateResponse: resp([["lookup_7"], ["lookup_3"]]) };
    expect(taskCompletionGrader()(comparison)).toBe(1);
  });

  it("fails when a required call was missed or replaced by the wrong one", () => {
    expect(taskCompletionGrader()({ request: {}, baselineResponse: resp([["lookup_7"]]), candidateResponse: resp([["lookup_wrong"]]) })).toBe(0);
  });

  it("scores partial recall when some required calls are missing", () => {
    const comparison = { request: {}, baselineResponse: resp([["lookup_7"], ["lookup_2"]]), candidateResponse: resp([["lookup_7"]]) };
    expect(taskCompletionGrader()(comparison)).toBe(0.5);
  });

  it("ignoreArguments matches on tool name alone", () => {
    const comparison = {
      request: {},
      baselineResponse: resp([["lookup_7", '{"accountId":"1"}']]),
      candidateResponse: resp([["lookup_7", '{"accountId":"2"}']]),
    };
    expect(taskCompletionGrader()(comparison)).toBe(0); // args differ
    expect(taskCompletionGrader({ ignoreArguments: true })(comparison)).toBe(1);
  });

  it("requireAnswer fails a candidate that produced no answer", () => {
    const comparison = { request: {}, baselineResponse: resp([["lookup_7"]], "done"), candidateResponse: resp([["lookup_7"]]) };
    expect(taskCompletionGrader()(comparison)).toBe(1); // calls matched
    expect(taskCompletionGrader({ requireAnswer: true })(comparison)).toBe(0); // but no answer
  });

  it("with no tool calls, passes unless the baseline answered and the candidate did not", () => {
    expect(taskCompletionGrader()({ request: {}, baselineResponse: resp([], "hi"), candidateResponse: resp([], "hi") })).toBe(1);
    expect(taskCompletionGrader()({ request: {}, baselineResponse: resp([], "hi"), candidateResponse: resp([]) })).toBe(0);
  });
});
