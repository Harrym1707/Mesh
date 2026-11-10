import { describe, expect, it } from "vitest";
import type { TokenPrice } from "./cost.js";
import {
  analysePromptCaching,
  applyReducers,
  approximateTokenCount,
  collapseWhitespace,
  dedupeRepeatedBlocks,
  dedupeRepeatedLeadingBlock,
  minifyJsonBlocks,
  priceReduction,
  recommendOutputCap,
} from "./token-reduction.js";

/** Claude Sonnet 5.5 shape: a cache-write premium plus a very cheap cached read. */
const withWritePremium: TokenPrice = {
  inputPerMillion: 2,
  cachedInputPerMillion: 0.1,
  cacheWriteInputPerMillion: 2.5,
  outputPerMillion: 10,
};

/** gpt-5 shape: cheap cached input, no separate write charge. */
const withoutWritePremium: TokenPrice = {
  inputPerMillion: 1.25,
  cachedInputPerMillion: 0.125,
  outputPerMillion: 10,
};

const paragraph = (seed: string) =>
  `${seed} ${"the quick brown fox jumped over the lazy dog and kept running ".repeat(6)}`;

describe("approximate token count", () => {
  it("counts nothing for an empty string", () => {
    expect(approximateTokenCount("")).toBe(0);
  });

  it("grows with text length", () => {
    const short = approximateTokenCount("hello world");
    const long = approximateTokenCount("hello world ".repeat(20));
    expect(long).toBeGreaterThan(short);
  });

  it("lands within a sane characters-per-token band on prose", () => {
    const prose = "The board approved the quarterly budget after a long discussion about hiring. ".repeat(10);
    const ratio = prose.length / approximateTokenCount(prose);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(6);
  });

  it("counts punctuation-dense text more densely than prose", () => {
    const json = '{"a":1,"b":[2,3],"c":{"d":"e"}}';
    const prose = "a".repeat(json.length);
    expect(approximateTokenCount(json)).toBeGreaterThan(approximateTokenCount(prose));
  });
});

describe("dedupeRepeatedBlocks", () => {
  it("drops a repeated large block and reports it", () => {
    const block = paragraph("context");
    const text = `${block}\n\nunique middle\n\n${block}`;
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toContain("unique middle");
    expect(result.text.split("the quick brown fox").length - 1).toBe(6);
    expect(result.notes).toHaveLength(1);
  });

  it("leaves short repeated phrasing alone", () => {
    const text = "please answer\n\nsomething else\n\nplease answer";
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });

  it("never dedupes blocks that differ only in whitespace (whitespace is content in code and YAML)", () => {
    const block = paragraph("ctx");
    const doubled = `${block}\n\n${block.replace(/ /g, "  ")}`;
    const result = dedupeRepeatedBlocks(24).reduce(doubled);
    expect(result.text).toBe(doubled);
    expect(result.notes).toEqual([]);
  });

  it("returns untouched text byte-identically, wide separators included", () => {
    const text = `alpha block one\n\n\n\nbeta block two`;
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });

  it("never dedupes fenced code blocks, even exact repeats", () => {
    const fence = "```json\n{ \"config\": \"the exact same fixture to compare\", \"padding\": \"yes yes yes\" }\n```";
    const text = `${fence}\n\n${fence}`;
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(text);
  });

  it("drops a duplicate excerpt joined by a single newline, as a RAG prompt would", () => {
    const excerptA = paragraph("Excerpt A:");
    const excerptB = paragraph("Excerpt B:");
    // picks.join("\n"): no blank line between excerpts, so the whole thing is
    // one top-level block and only line-level dedupe can catch the repeat.
    const text = `Context:\n${excerptA}\n${excerptB}\n${excerptA}\nQuestion: what does it require?`;
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(`Context:\n${excerptA}\n${excerptB}\nQuestion: what does it require?`);
    expect(result.text.split("Excerpt A:").length - 1).toBe(1);
    expect(result.notes).toHaveLength(1);
  });

  it("still catches a duplicate line against an earlier whole block", () => {
    const block = paragraph("shared");
    // First occurrence is its own blank-line-separated block; the second is a
    // single line buried inside a later, otherwise-unique block.
    const text = `${block}\n\nheader line\n${block}\nfooter line`;
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(`${block}\n\nheader line\nfooter line`);
    expect(result.notes).toHaveLength(1);
  });

  it("never dedupes a repeated line inside a fenced code block", () => {
    const line = paragraph("same line");
    const fence = `\`\`\`text\n${line}\n${line}\n\`\`\``;
    const result = dedupeRepeatedBlocks(24).reduce(fence);
    expect(result.text).toBe(fence);
    expect(result.notes).toEqual([]);
  });

  it("never dedupes lines that differ only in whitespace", () => {
    const line = paragraph("line");
    const text = `${line}\n${line.replace(/ /g, "  ")}`;
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });

  it("leaves short duplicate lines alone, same as short duplicate blocks", () => {
    const text = "please answer\nsomething else\nplease answer";
    const result = dedupeRepeatedBlocks(24).reduce(text);
    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });
});

describe("dedupeRepeatedLeadingBlock", () => {
  const memory = paragraph("AGENT MEMORY: persistent facts about the account go here.");

  it("replaces a repeated leading block in later turns, keeping the differing remainder verbatim", () => {
    const texts = [
      `${memory}\nTurn 0: handle request 0.`,
      `${memory}\nTurn 1: handle request 1.`,
      `${memory}\nTurn 2: handle request 2.`,
    ];
    const result = dedupeRepeatedLeadingBlock(texts, 24);
    expect(result.texts[0]).toBe(texts[0]);
    expect(result.texts[1]).toContain("Turn 1: handle request 1.");
    expect(result.texts[1]).not.toContain("AGENT MEMORY");
    expect(result.texts[2]).toContain("Turn 2: handle request 2.");
    expect(result.notes).toHaveLength(2);
  });

  it("never cuts into a line that only coincidentally shares leading characters", () => {
    // Both turns open with "Turn " before diverging at the digit: a naive
    // character-level common prefix would eat into the digit's own line.
    const texts = ["Turn 0: alpha.", "Turn 2: beta."];
    const result = dedupeRepeatedLeadingBlock(texts, 1);
    expect(result.texts[1]).toBe("Turn 2: beta.");
    expect(result.notes).toEqual([]);
  });

  it("leaves texts alone when the shared block falls below the minimum", () => {
    const texts = [`${memory}\nTurn 0.`, `${memory}\nTurn 1.`];
    const result = dedupeRepeatedLeadingBlock(texts, 100_000);
    expect(result.texts).toEqual(texts);
    expect(result.notes).toEqual([]);
  });

  it("is a no-op on a single text", () => {
    const result = dedupeRepeatedLeadingBlock([`${memory}\nTurn 0.`], 24);
    expect(result.texts).toEqual([`${memory}\nTurn 0.`]);
  });

  it("is a no-op when nothing repeats", () => {
    const texts = ["alpha context entirely its own.", "beta context, unrelated to alpha."];
    const result = dedupeRepeatedLeadingBlock(texts, 1);
    expect(result.texts).toEqual(texts);
    expect(result.notes).toEqual([]);
  });

  it("never dedupes a leading block that contains a fenced code sample", () => {
    const fence = "```json\n{ \"k\": \"v\" }\n```";
    const texts = [`${fence}\nTurn 0.`, `${fence}\nTurn 1.`];
    const result = dedupeRepeatedLeadingBlock(texts, 1);
    expect(result.texts).toEqual(texts);
  });

  it("handles full containment (an earlier, shorter text fully repeated as a later text's prefix)", () => {
    const short = paragraph("short canonical block");
    const texts = [short, `${short} plus a continuation that is unique.`];
    const result = dedupeRepeatedLeadingBlock(texts, 24);
    expect(result.texts[1]).toContain("plus a continuation that is unique.");
    expect(result.texts[1]).not.toContain("short canonical block");
  });

  it("is deterministic and idempotent: re-running on its own output changes nothing further", () => {
    const texts = [
      `${memory}\nTurn 0: handle request 0.`,
      `${memory}\nTurn 1: handle request 1.`,
      `${memory}\nTurn 2: handle request 2.`,
    ];
    const once = dedupeRepeatedLeadingBlock(texts, 24);
    const twice = dedupeRepeatedLeadingBlock(once.texts, 24);
    expect(twice.texts).toEqual(once.texts);
  });
});

describe("collapseWhitespace", () => {
  it("collapses runs of spaces and blank lines", () => {
    const result = collapseWhitespace().reduce("alpha    beta\n\n\n\ngamma   ");
    expect(result.text).toBe("alpha beta\n\ngamma");
    expect(result.notes).toHaveLength(1);
  });

  it("preserves fenced code exactly, including its indentation", () => {
    const code = "```python\ndef f():\n    return    1\n```";
    const result = collapseWhitespace().reduce(`before    text\n\n${code}\n\nafter    text`);
    expect(result.text).toContain(code);
    expect(result.text).toContain("before text");
  });

  it("preserves inline code spans", () => {
    const result = collapseWhitespace().reduce("use `a    b` here    now");
    expect(result.text).toContain("`a    b`");
  });

  it("leaves already-tight text unchanged and reports nothing", () => {
    const result = collapseWhitespace().reduce("alpha beta");
    expect(result.text).toBe("alpha beta");
    expect(result.notes).toEqual([]);
  });
});

describe("minifyJsonBlocks", () => {
  it("minifies pretty-printed JSON inside a json fence, preserving values", () => {
    const pretty = '```json\n{\n  "name": "alice",\n  "roles": [\n    "admin",\n    "user"\n  ]\n}\n```';
    const result = minifyJsonBlocks().reduce(pretty);
    expect(result.text).toContain('```json\n{"name":"alice","roles":["admin","user"]}\n```');
    expect(result.notes).toHaveLength(1);
    // The surviving JSON parses back to the same value.
    const body = result.text.replace(/```json\n|\n```/g, "");
    expect(JSON.parse(body)).toEqual({ name: "alice", roles: ["admin", "user"] });
    expect(result.text.length).toBeLessThan(pretty.length);
  });

  it("leaves invalid JSON and non-json fences byte-identical", () => {
    const notJson = "```json\nthis is not json\n```";
    expect(minifyJsonBlocks().reduce(notJson).text).toBe(notJson);
    const python = "```python\n{ 'a':   1 }\n```";
    expect(minifyJsonBlocks().reduce(python).text).toBe(python);
  });

  it("never increases token count (safe in applyReducers)", () => {
    const text = '```json\n{"already":"tight"}\n```\nprose    here';
    const before = approximateTokenCount(text);
    const result = minifyJsonBlocks().reduce(text);
    expect(approximateTokenCount(result.text)).toBeLessThanOrEqual(before);
  });
});

describe("applyReducers", () => {
  it("accumulates savings across reducers", () => {
    const block = paragraph("ctx");
    const text = `${block}\n\n\n\n${block}`;
    const result = applyReducers(text, [dedupeRepeatedBlocks(24), collapseWhitespace()]);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[0]!.tokensSaved).toBeGreaterThan(0);
  });

  it("refuses a reducer that makes a request larger", () => {
    const grow = {
      id: "grow",
      version: "1",
      risk: "lossless" as const,
      reduce: (text: string) => ({ text: `${text} and more and more words here`, notes: [] }),
    };
    expect(() => applyReducers("short text", [grow])).toThrow(/increased token count/);
  });

  it("returns the input unchanged when given no reducers", () => {
    const result = applyReducers("alpha beta", []);
    expect(result.text).toBe("alpha beta");
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });
});

describe("analysePromptCaching", () => {
  const stablePrefix = `You are a support agent. ${"Follow these rules carefully at all times. ".repeat(200)}`;

  it("finds the prefix shared across requests", () => {
    const requests = [1, 2, 3].map((index) => `${stablePrefix}\n\nTicket ${index}: my order is late.`);
    const analysis = analysePromptCaching(requests, { price: withWritePremium });
    expect(analysis.requests).toBe(3);
    expect(analysis.sharedPrefixTokens).toBeGreaterThan(1024);
    expect(analysis.cacheablePrefixShare).toBeGreaterThan(0.9);
  });

  it("projects a large saving for a long stable prefix", () => {
    const requests = Array.from({ length: 100 }, (_, index) =>
      `${stablePrefix}\n\nTicket ${index}: my order is late.`);
    const analysis = analysePromptCaching(requests, { price: withWritePremium });
    expect(analysis.projection.status).toBe("priced");
    if (analysis.projection.status !== "priced") throw new Error("expected a priced projection");
    // One write at 1.25x plus 99 reads at 1/20th replaces 100 full-rate prefixes.
    expect(analysis.projection.savingPercent).toBeGreaterThan(85);
    expect(analysis.projection.savingUsd).toBeGreaterThan(0);
  });

  it("saves less where the provider has no write premium but still saves most of it", () => {
    const requests = Array.from({ length: 100 }, (_, index) => `${stablePrefix}\n\nTicket ${index}.`);
    const premium = analysePromptCaching(requests, { price: withWritePremium }).projection;
    const plain = analysePromptCaching(requests, { price: withoutWritePremium }).projection;
    if (premium.status !== "priced" || plain.status !== "priced") throw new Error("expected priced projections");
    expect(plain.savingPercent).toBeGreaterThan(80);
  });

  it("reports a timestamp in the prefix as recoverable headroom", () => {
    const requests = [
      `Current time: 2026-10-09T08:00:00Z\n${stablePrefix}\n\nTicket one.`,
      `Current time: 2026-10-09T09:30:00Z\n${stablePrefix}\n\nTicket two.`,
      `Current time: 2026-10-09T11:15:00Z\n${stablePrefix}\n\nTicket three.`,
    ];
    const analysis = analysePromptCaching(requests, { price: withWritePremium });
    // The clock breaks the prefix almost immediately, so nothing caches today.
    expect(analysis.sharedPrefixTokens).toBeLessThan(20);
    // Masking it reveals the whole system prompt was otherwise identical.
    expect(analysis.recoverablePrefixTokens).toBeGreaterThan(1024);
    expect(analysis.prefixBreakers.some((breaker) => breaker.kind === "timestamp")).toBe(true);
    if (analysis.projection.status !== "priced") throw new Error("expected a priced projection");
    expect(analysis.projection.recoverableSavingUsd).toBeGreaterThan(0);
  });

  it("detects uuids as prefix breakers", () => {
    const requests = [
      `Request 11111111-2222-3333-4444-555555555555\n${stablePrefix}\n\nOne.`,
      `Request 66666666-7777-8888-9999-aaaaaaaaaaaa\n${stablePrefix}\n\nTwo.`,
    ];
    const analysis = analysePromptCaching(requests, { price: withWritePremium });
    expect(analysis.prefixBreakers.some((breaker) => breaker.kind === "uuid")).toBe(true);
    expect(analysis.recoverablePrefixTokens).toBeGreaterThan(analysis.sharedPrefixTokens);
  });

  it("treats a prefix below the provider floor as uncacheable", () => {
    const requests = ["Shared short lead in. Ticket one.", "Shared short lead in. Ticket two."];
    const analysis = analysePromptCaching(requests, {
      price: withWritePremium,
      minimumCacheableTokens: 1024,
    });
    expect(analysis.cacheablePrefixShare).toBe(0);
    if (analysis.projection.status !== "priced") throw new Error("expected a priced projection");
    expect(analysis.projection.savingUsd).toBe(0);
  });

  it("reports tokens only when no cached-input rate is available", () => {
    const requests = [1, 2].map((index) => `${stablePrefix}\n\nTicket ${index}.`);
    const analysis = analysePromptCaching(requests, {
      price: { inputPerMillion: 2, outputPerMillion: 10 },
    });
    expect(analysis.projection.status).toBe("unpriced");
    expect(analysis.sharedPrefixTokens).toBeGreaterThan(0);
  });

  it("needs at least two requests to find anything shared", () => {
    expect(() => analysePromptCaching(["only one"], {})).toThrow(/at least two requests/);
  });
});

describe("recommendOutputCap", () => {
  const lengths = [...Array.from({ length: 95 }, () => 200), 900, 1_200, 4_000, 9_000, 20_000];

  it("caps at the chosen quantile and truncates only the tail beyond it", () => {
    // 95 of 100 responses are 200 tokens, so the 95th percentile is 200 and
    // exactly the five long responses are affected.
    const atNinetyFive = recommendOutputCap(lengths, { quantile: 0.95, headroom: 1 });
    expect(atNinetyFive.recommendedCap).toBe(200);
    expect(atNinetyFive.truncationRate).toBeCloseTo(0.05, 10);
    expect(atNinetyFive.maxObserved).toBe(20_000);

    // A higher quantile buys back the tail: only the single worst response is cut.
    const atNinetyNine = recommendOutputCap(lengths, { quantile: 0.99, headroom: 1 });
    expect(atNinetyNine.recommendedCap).toBe(9_000);
    expect(atNinetyNine.truncationRate).toBeCloseTo(0.01, 10);
    expect(atNinetyNine.projectedTokensSaved).toBe(20_000 - 9_000);
  });

  it("saves more at a tighter quantile, which is the cost/quality dial", () => {
    const tight = recommendOutputCap(lengths, { quantile: 0.95, headroom: 1 });
    const loose = recommendOutputCap(lengths, { quantile: 0.99, headroom: 1 });
    expect(tight.projectedTokensSaved).toBeGreaterThan(loose.projectedTokensSaved);
    expect(tight.truncationRate).toBeGreaterThan(loose.truncationRate);
  });

  it("counts only tokens above the cap as saved", () => {
    const advice = recommendOutputCap([100, 100, 1_000], { quantile: 0.5, headroom: 1 });
    expect(advice.recommendedCap).toBe(100);
    expect(advice.projectedTokensSaved).toBe(900);
  });

  it("prices the saving at the output rate, the expensive half of the bill", () => {
    const advice = recommendOutputCap([100, 100, 1_000_100], {
      quantile: 0.5,
      headroom: 1,
      price: withWritePremium,
    });
    expect(advice.projectedSavingUsd).toBeCloseTo(10, 5);
  });

  it("truncates nothing when the cap sits at the maximum", () => {
    const advice = recommendOutputCap(lengths, { quantile: 1, headroom: 1 });
    expect(advice.truncationRate).toBe(0);
    expect(advice.projectedTokensSaved).toBe(0);
  });

  it("applies headroom above the chosen quantile", () => {
    const tight = recommendOutputCap([100, 200], { quantile: 1, headroom: 1 });
    const loose = recommendOutputCap([100, 200], { quantile: 1, headroom: 1.5 });
    expect(loose.recommendedCap).toBeGreaterThan(tight.recommendedCap);
  });

  it("rejects empty or invalid observations", () => {
    expect(() => recommendOutputCap([])).toThrow(/observed response lengths/);
    expect(() => recommendOutputCap([-1])).toThrow(/non-negative/);
    expect(() => recommendOutputCap([10], { quantile: 0 })).toThrow(/quantile/);
    expect(() => recommendOutputCap([10], { headroom: 0.5 })).toThrow(/headroom/);
  });
});

describe("priceReduction", () => {
  it("values an output token saving above an equal input saving", () => {
    const input = priceReduction(1_000_000, 0, withWritePremium).savingUsd!;
    const output = priceReduction(0, 1_000_000, withWritePremium).savingUsd!;
    expect(output / input).toBeCloseTo(5, 5);
  });

  it("returns tokens only when no price is given", () => {
    const saving = priceReduction(100, 50);
    expect(saving.savingUsd).toBeUndefined();
    expect(saving.inputTokensSaved).toBe(100);
  });

  it("rejects negative savings", () => {
    expect(() => priceReduction(-1, 0)).toThrow(/cannot be negative/);
  });
});
