import { describe, expect, it } from "vitest";
import {
  FACTS,
  MEMORY_BLOCK,
  TASKS,
  TURNS_PER_TASK,
  buildFixtureRequests,
  estimateRecall,
  flattenPrompt,
  recallProbability,
} from "./memory-dedup-fixture.js";

describe("memory-dedup-fixture", () => {
  it("builds TASKS x TURNS_PER_TASK requests, each tagged with a fact that is actually in the memory block", () => {
    const fixture = buildFixtureRequests();
    expect(fixture).toHaveLength(TASKS * TURNS_PER_TASK);
    for (const row of fixture) {
      expect(FACTS).toContain(row.requiredFact);
      expect(MEMORY_BLOCK.includes(row.requiredFact)).toBe(true);
    }
  });

  it("grows history: a task's turn k has k+1 user messages and k assistant replies", () => {
    const fixture = buildFixtureRequests();
    const taskZero = fixture.filter((row) => row.taskIndex === 0);
    expect(taskZero).toHaveLength(TURNS_PER_TASK);
    for (const row of taskZero) {
      const messages = (row.request as { messages: unknown[] }).messages;
      expect(messages).toHaveLength(2 * row.turn + 1);
      expect((messages[messages.length - 1] as { role: string }).role).toBe("user");
    }
  });

  it("carries requiredFact through request.metadata (identity-independent lookup)", () => {
    const fixture = buildFixtureRequests();
    for (const row of fixture) {
      const metadata = (row.request as { metadata: { requiredFact: string } }).metadata;
      expect(metadata.requiredFact).toBe(row.requiredFact);
    }
  });

  it("flattenPrompt reads plain-string system and message content", () => {
    const prompt = flattenPrompt({
      system: "preamble text",
      messages: [{ role: "user", content: "hello there" }],
    });
    expect(prompt).toContain("preamble text");
    expect(prompt).toContain("hello there");
  });

  it("flattenPrompt reads array-of-text-block content the same way a stamped request would carry it", () => {
    const prompt = flattenPrompt({
      system: [{ type: "text", text: "preamble " }, { type: "text", text: "continued" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }],
    });
    expect(prompt).toContain("preamble continued");
    expect(prompt).toContain("hello there");
  });

  it("estimateRecall reports found: false and probability 0 when the fact is not in the prompt", () => {
    const estimate = estimateRecall("nothing relevant here", FACTS[0]!);
    expect(estimate.found).toBe(false);
    expect(estimate.recallProbability).toBe(0);
  });

  it("estimateRecall uses the LAST occurrence, not the first", () => {
    const fact = FACTS[0]!;
    const prompt = `${fact} filler ${"x ".repeat(500)}${fact}`;
    const estimate = estimateRecall(prompt, fact);
    // The last occurrence is immediately followed by nothing, so distance is ~0 -
    // at ceiling - even though the FIRST occurrence is buried under ~500 tokens
    // of filler. A lookup that used indexOf instead of lastIndexOf would report
    // a large distance here and understate the model's best-case reading.
    expect(estimate.distanceTokens).toBeLessThan(5);
    expect(estimate.recallProbability).toBeGreaterThan(0.9);
  });

  it("recallProbability is at ceiling when the fact is adjacent to the end of the prompt", () => {
    expect(recallProbability(0, 500)).toBeGreaterThan(0.98);
    expect(recallProbability(100, 500)).toBeGreaterThan(0.98);
  });

  it("recallProbability drops below ceiling once distance clears the adjacency threshold", () => {
    const adjacent = recallProbability(100, 2000);
    const distant = recallProbability(2000, 2000);
    expect(distant).toBeLessThan(adjacent);
  });

  it("recallProbability erodes mildly as total context grows, but never below its floor", () => {
    const shortContext = recallProbability(5000, 1000);
    const longContext = recallProbability(5000, 50000);
    expect(longContext).toBeLessThanOrEqual(shortContext);
    expect(longContext).toBeGreaterThanOrEqual(0.55);
    expect(recallProbability(5000, 10_000_000)).toBe(0.55);
  });

  it("recallProbability never exceeds 1 or drops below 0", () => {
    for (const distance of [0, 50, 150, 151, 1000, 10_000, 1_000_000]) {
      for (const total of [0, 100, 10_000, 1_000_000]) {
        const value = recallProbability(distance, total);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
