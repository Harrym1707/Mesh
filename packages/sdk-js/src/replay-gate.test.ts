import { describe, expect, it } from "vitest";
import {
  exactTextGrader,
  replayGate,
  replayUsage,
  responseText,
  responseToolCalls,
  toolNameGrader,
  toolSelectionGrader,
  type ReplayCandidate,
} from "./replay-gate.js";

type AnyObject = Record<string, unknown>;

function toolResponse(name: string, args: AnyObject = { accountId: "1" }, inputTokens = 1_000): unknown {
  return {
    output: [{ type: "function_call", name, arguments: JSON.stringify(args) }],
    usage: { input_tokens: inputTokens, output_tokens: 20 },
  };
}

function requests(count = 20): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    model: "gpt-5",
    instructions: "You are an agent.",
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look up a record. Use this for refunds. Returns a paginated list ordered by time.",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { accountId: { type: "string", title: "accountId" } },
        },
      },
    }],
    input: [{ role: "user", content: `Question ${index}` }],
  }));
}

const losslessOnly: ReplayCandidate = { label: "lossless", config: { toolSchemas: true } };

describe("response readers", () => {
  it("reads usage from both provider shapes", () => {
    expect(replayUsage({ usage: { input_tokens: 10, output_tokens: 2 } }))
      .toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
    expect(replayUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } }))
      .toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
    expect(replayUsage({ usage: {} })).toBeUndefined();
    expect(replayUsage("nope")).toBeUndefined();
  });

  it("reads cached tokens, which the gate must price to see a caching saving", () => {
    // OpenAI reports cached tokens INSIDE input_tokens.
    expect(replayUsage({
      usage: { input_tokens: 1_000, output_tokens: 20, input_tokens_details: { cached_tokens: 800 } },
    })).toEqual({ inputTokens: 1_000, outputTokens: 20, cachedInputTokens: 800, cacheWriteInputTokens: 0 });

    // Chat Completions uses a differently named details object.
    expect(replayUsage({
      usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } },
    })).toEqual({ inputTokens: 500, outputTokens: 10, cachedInputTokens: 100, cacheWriteInputTokens: 0 });

    // Anthropic reports cache reads and writes ALONGSIDE input_tokens, so the
    // total is the sum; reporting only the fresh count would understate input.
    expect(replayUsage({
      usage: {
        input_tokens: 900,
        cache_read_input_tokens: 3_400,
        cache_creation_input_tokens: 100,
        output_tokens: 50,
      },
    })).toEqual({
      inputTokens: 4_400, outputTokens: 50, cachedInputTokens: 3_400, cacheWriteInputTokens: 100,
    });
  });

  it("never reports more cached tokens than total input", () => {
    const usage = replayUsage({
      usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 9_999 } },
    })!;
    expect(usage.cachedInputTokens).toBeLessThanOrEqual(usage.inputTokens);
  });

  it("collects assistant text from nested content", () => {
    expect(responseText({ output: [{ content: [{ type: "output_text", text: "hello" }] }] })).toBe("hello");
    expect(responseText({ output_text: "direct" })).toBe("direct");
  });

  it("normalises tool-call arguments so key order cannot make equal calls differ", () => {
    const left = responseToolCalls(toolResponse("lookup", { a: 1, b: 2 }));
    const right = responseToolCalls({
      output: [{ type: "function_call", name: "lookup", arguments: '{"b":2,"a":1}' }],
    });
    // Reparsed and re-serialised, so these compare equal despite the key order.
    expect(left[0]!.argumentsJson).toBe(right[0]!.argumentsJson);
  });

  it("does not report one call twice when the walk reaches it by two paths", () => {
    expect(responseToolCalls(toolResponse("lookup"))).toHaveLength(1);
  });
});

describe("graders", () => {
  it("scores identical tool choices as a match and different ones as a miss", () => {
    const same = toolSelectionGrader({
      request: {},
      baselineResponse: toolResponse("lookup_refunds"),
      candidateResponse: toolResponse("lookup_refunds"),
    });
    const different = toolSelectionGrader({
      request: {},
      baselineResponse: toolResponse("lookup_refunds"),
      candidateResponse: toolResponse("lookup_payouts"),
    });
    expect(same).toBe(1);
    expect(different).toBe(0);
  });

  it("penalises the same tool called with different arguments", () => {
    const score = toolSelectionGrader({
      request: {},
      baselineResponse: toolResponse("lookup", { accountId: "1" }),
      candidateResponse: toolResponse("lookup", { accountId: "2" }),
    });
    expect(score).toBe(0);
    // The name grader deliberately ignores arguments.
    expect(toolNameGrader({
      request: {},
      baselineResponse: toolResponse("lookup", { accountId: "1" }),
      candidateResponse: toolResponse("lookup", { accountId: "2" }),
    })).toBe(1);
  });

  it("treats two responses that called nothing as equivalent", () => {
    expect(toolSelectionGrader({ request: {}, baselineResponse: {}, candidateResponse: {} })).toBe(1);
  });

  it("compares assistant text exactly", () => {
    const text = (value: string) => ({ output_text: value });
    expect(exactTextGrader({ request: {}, baselineResponse: text("a"), candidateResponse: text("a") })).toBe(1);
    expect(exactTextGrader({ request: {}, baselineResponse: text("a"), candidateResponse: text("b") })).toBe(0);
  });
});

describe("replayGate", () => {
  it("approves a candidate whose quality holds and measures its saving from provider usage", async () => {
    // The candidate request is smaller, so the stub reports fewer input tokens.
    const call = async (request: unknown) => {
      const size = JSON.stringify(request).length;
      return toolResponse("lookup", { accountId: "1" }, size);
    };
    const result = await replayGate({
      requests: requests(),
      call,
      candidates: [losslessOnly],
      grade: toolSelectionGrader,
    });
    const candidate = result.candidates[0]!;
    expect(candidate.approved).toBe(true);
    expect(candidate.inputTokensSaved).toBeGreaterThan(0);
    // Savings come from the reported usage, not MESH's estimate.
    expect(candidate.baselineUsage.inputTokens).toBeGreaterThan(candidate.candidateUsage.inputTokens);
  });

  it("rejects a candidate that changes the model's tool choice", async () => {
    // Trimming the description past the discriminating sentence makes the stub
    // pick a different tool, which is this lever's real failure mode.
    const call = async (request: unknown) => {
      const text = JSON.stringify(request);
      const size = text.length;
      return toolResponse(text.includes("Use this for refunds") ? "lookup" : "wrong_tool", { accountId: "1" }, size);
    };
    const result = await replayGate({
      requests: requests(),
      call,
      candidates: [{ label: "aggressive", config: { toolSchemas: { descriptions: "drop" } } }],
      grade: toolSelectionGrader,
    });
    const candidate = result.candidates[0]!;
    expect(candidate.approved).toBe(false);
    expect(candidate.rejectionReason).toMatch(/breaches/);
    // The saving was real; it simply was not allowed.
    expect(candidate.inputTokensSaved).toBeGreaterThan(0);
  });

  it("picks the most aggressive candidate that held quality", async () => {
    const call = async (request: unknown) => {
      const text = JSON.stringify(request);
      return toolResponse(text.includes("Use this for refunds") ? "lookup" : "wrong_tool", { accountId: "1" }, text.length);
    };
    const result = await replayGate({
      requests: requests(),
      call,
      candidates: [
        losslessOnly,
        { label: "trim-40", config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 } } },
        { label: "drop", config: { toolSchemas: { descriptions: "drop" } } },
      ],
      grade: toolSelectionGrader,
    });
    expect(result.approved).toBeDefined();
    // Both safe candidates held, so the one saving more wins; the unsafe one
    // saves most of all and must not be chosen.
    expect(result.approved!.label).not.toBe("drop");
    expect(result.approved!.tokenSavingPercent)
      .toBeGreaterThanOrEqual(result.candidates.find((row) => row.label === "lossless")!.tokenSavingPercent);
  });

  it("refuses a candidate that held quality but saved nothing", async () => {
    const call = async () => toolResponse("lookup", { accountId: "1" }, 1_000);
    const result = await replayGate({
      requests: requests(),
      call,
      candidates: [losslessOnly],
      grade: toolSelectionGrader,
    });
    expect(result.candidates[0]!.approved).toBe(false);
    expect(result.candidates[0]!.rejectionReason).toMatch(/nothing to enable/);
  });

  it("widens the band as more candidates are searched", async () => {
    // A noisy grader, so the bound is not pinned at zero.
    let flip = 0;
    const call = async (request: unknown) => {
      flip += 1;
      return toolResponse(flip % 7 === 0 ? "other" : "lookup", { accountId: "1" }, JSON.stringify(request).length);
    };
    const one = await replayGate({
      requests: requests(30), call, candidates: [losslessOnly], grade: toolSelectionGrader, seed: "fixed",
    });
    const many = await replayGate({
      requests: requests(30),
      call,
      candidates: [
        losslessOnly,
        { label: "b", config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 30 } } },
        { label: "c", config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 20 } } },
      ],
      grade: toolSelectionGrader,
      seed: "fixed",
    });
    const lossless = many.candidates.find((row) => row.label === "lossless")!;
    expect(lossless.lower95QualityDelta).toBeLessThanOrEqual(one.candidates[0]!.lower95QualityDelta);
  });

  it("reuses recorded baselines instead of paying for them again", async () => {
    let calls = 0;
    const call = async (request: unknown) => {
      calls += 1;
      return toolResponse("lookup", { accountId: "1" }, JSON.stringify(request).length);
    };
    const sample = requests(10);
    const recorded = sample.map(() => toolResponse("lookup", { accountId: "1" }, 5_000));
    const result = await replayGate({
      requests: sample,
      call,
      candidates: [losslessOnly],
      grade: toolSelectionGrader,
      baselineResponses: recorded,
    });
    // Only the candidate run was paid for.
    expect(calls).toBe(10);
    expect(result.calls).toBe(10);
    expect(result.notes.some((note) => /Baseline responses were supplied/.test(note))).toBe(true);
  });

  it("reports how many provider calls the replay cost", async () => {
    const call = async (request: unknown) => toolResponse("lookup", { accountId: "1" }, JSON.stringify(request).length);
    const result = await replayGate({
      requests: requests(10),
      call,
      candidates: [losslessOnly, { label: "b", config: { toolSchemas: true } }],
      grade: toolSelectionGrader,
    });
    // 10 baseline plus 10 per candidate.
    expect(result.calls).toBe(30);
  });

  it("counts a failing grader as a failure rather than a pass", async () => {
    const call = async (request: unknown) => toolResponse("lookup", { accountId: "1" }, JSON.stringify(request).length);
    const result = await replayGate({
      requests: requests(10),
      call,
      candidates: [losslessOnly],
      grade: () => { throw new Error("grader exploded"); },
    }).catch((cause: unknown) => cause as Error);
    // Every comparison failed, so there is no verdict to give.
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/gradeable/);
  });

  it("survives a provider error on individual requests", async () => {
    let index = 0;
    const call = async (request: unknown) => {
      index += 1;
      if (index % 5 === 0) throw new Error("rate limited");
      return toolResponse("lookup", { accountId: "1" }, JSON.stringify(request).length);
    };
    const result = await replayGate({
      requests: requests(20),
      call,
      candidates: [losslessOnly],
      grade: toolSelectionGrader,
    });
    expect(result.candidates[0]!.failed).toBeGreaterThan(0);
    expect(result.candidates[0]!.graded).toBeGreaterThan(0);
  });

  it("credits a candidate that changed only the rate its tokens were billed at", async () => {
    // Same token count both ways; the candidate simply arrives cached. Pricing
    // input at the full rate would make prefix caching look worthless.
    const call = async (request: unknown) => {
      const cached = JSON.stringify(request).includes("$schema") ? 0 : 900;
      return {
        output: [{ type: "function_call", name: "lookup", arguments: '{"accountId":"1"}' }],
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: cached },
        },
      };
    };
    const result = await replayGate({
      requests: requests(20),
      call,
      candidates: [losslessOnly],
      grade: toolSelectionGrader,
      price: { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
    });
    const candidate = result.candidates[0]!;
    expect(candidate.candidateUsage.cachedInputTokens).toBeGreaterThan(0);
    // No tokens were removed, yet the bill fell.
    expect(candidate.inputTokensSaved).toBe(0);
    expect(candidate.costSavedUsd!).toBeGreaterThan(0);
    expect(candidate.approved).toBe(true);
  });

  it("refuses compaction that removes tokens but raises the bill by rewriting a cached prefix", async () => {
    // The failure mode the cache-simulator predicted: summarising stale turns
    // shrinks the prompt, yet the summary rewrites a prefix the provider was
    // serving cheaply from cache. Fewer tokens, bigger bill. Tool choice is
    // unchanged, so quality holds — only the cost test can catch this.
    const call = async (request: unknown) => {
      const reduced = !JSON.stringify(request).includes("$schema"); // losslessOnly strips plumbing
      const usage = reduced
        // Candidate: 700 input tokens, but 600 of them are a fresh cache WRITE.
        ? { input_tokens: 100, cache_creation_input_tokens: 600, output_tokens: 20 }
        // Baseline: 1,000 input tokens, 900 of them served cheap from cache.
        : { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 };
      return { output: [{ type: "function_call", name: "lookup", arguments: '{"accountId":"1"}' }], usage };
    };
    const result = await replayGate({
      requests: requests(20),
      call,
      candidates: [losslessOnly],
      grade: toolSelectionGrader,
      price: { inputPerMillion: 2.0, cachedInputPerMillion: 0.1, cacheWriteInputPerMillion: 2.5, outputPerMillion: 10 },
    });
    const candidate = result.candidates[0]!;
    // Tokens genuinely fell...
    expect(candidate.inputTokensSaved).toBeGreaterThan(0);
    // ...but the bill rose, so the gate must withhold it despite the saved tokens.
    expect(candidate.costSavedUsd!).toBeLessThan(0);
    expect(candidate.approved).toBe(false);
    expect(candidate.rejectionReason).toMatch(/cache writes and reads/);
  });

  it("resets provider state before each run so the baseline cannot warm it", async () => {
    const seen: string[] = [];
    const call = async (request: unknown) => toolResponse("lookup", { accountId: "1" }, JSON.stringify(request).length);
    await replayGate({
      requests: requests(4),
      call,
      candidates: [losslessOnly, { label: "second", config: { toolSchemas: true } }],
      grade: toolSelectionGrader,
      beforeRun: (label) => { seen.push(label); },
    });
    expect(seen).toEqual(["baseline", "lossless", "second"]);
  });

  it("validates its inputs", async () => {
    const call = async () => toolResponse("lookup");
    await expect(replayGate({ requests: [], call, candidates: [losslessOnly], grade: toolSelectionGrader }))
      .rejects.toThrow(/at least one request/);
    await expect(replayGate({ requests: requests(2), call, candidates: [], grade: toolSelectionGrader }))
      .rejects.toThrow(/at least one candidate/);
    await expect(replayGate({
      requests: requests(2), call, candidates: [losslessOnly], grade: toolSelectionGrader, maximumQualityDrop: 2,
    })).rejects.toThrow(/between 0 and 1/);
    await expect(replayGate({
      requests: requests(2), call, candidates: [losslessOnly], grade: toolSelectionGrader, baselineResponses: [{}],
    })).rejects.toThrow(/one-to-one/);
  });
});
