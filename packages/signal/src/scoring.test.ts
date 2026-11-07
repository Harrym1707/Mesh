import { describe, expect, it } from "vitest";
import type { AnswerSample, BrandProfile } from "./schema.js";
import {
  detectCategoryAssociations,
  detectCitation,
  detectCompetitors,
  detectLink,
  detectMention,
  domainOf,
  scoreAnswer,
  scoreFactualDescription,
  scoreSourceOverlap,
} from "./scoring.js";

const BRAND: BrandProfile = {
  name: "MESH",
  aliases: ["mesh.ai"],
  ownedDomains: ["mesh-ai.dev", "https://github.com/org/mesh"],
  categories: [
    { id: "routing", label: "LLM routing", keywords: ["llm routing", "model routing"] },
    { id: "caching", label: "Semantic caching", keywords: ["semantic caching"] },
  ],
  canonicalClaims: [
    {
      id: "category",
      supportedBy: ["ai cost engineering", "inference optimisation"],
      contradictedBy: ["mesh wifi", "service mesh"],
    },
    { id: "quality", supportedBy: ["without compromising quality"] },
  ],
  competitors: ["OpenRouter", "LiteLLM"],
};

const ctx = { runId: "run-0", timestamp: "2026-11-07T00:00:00.000Z" };

function sample(partial: Partial<AnswerSample>): AnswerSample {
  return { engine: "chatgpt", query: "how do I reduce llm cost?", text: "", ...partial };
}

describe("domainOf", () => {
  it("strips scheme, path, query and leading www, lowercasing the host", () => {
    expect(domainOf("https://www.Mesh-AI.dev/docs?x=1")).toBe("mesh-ai.dev");
    expect(domainOf("github.com/org/mesh")).toBe("github.com");
    expect(domainOf("")).toBeUndefined();
    expect(domainOf(undefined)).toBeUndefined();
  });
});

describe("detectMention", () => {
  it("matches the brand as a whole token, case-insensitively", () => {
    expect(detectMention(sample({ text: "You could try MESH for this." }), BRAND)).toBe(true);
    expect(detectMention(sample({ text: "the mesh.ai sdk" }), BRAND)).toBe(true);
  });

  it("does not match the brand name inside a larger word", () => {
    expect(detectMention(sample({ text: "the meshing of gears" }), BRAND)).toBe(false);
    expect(detectMention(sample({ text: "an enmeshed system" }), BRAND)).toBe(false);
  });
});

describe("detectCitation", () => {
  it("counts a cited owned domain", () => {
    const s = sample({ citations: [{ url: "https://mesh-ai.dev/benchmarks" }] });
    expect(detectCitation(s, BRAND)).toBe(true);
  });

  it("counts a citation whose title names the brand even without an owned domain", () => {
    const s = sample({ citations: [{ domain: "news.example.com", title: "How MESH cuts cost" }] });
    expect(detectCitation(s, BRAND)).toBe(true);
  });

  it("is false when sources are all third-party and unnamed", () => {
    const s = sample({ citations: [{ url: "https://openai.com/pricing" }] });
    expect(detectCitation(s, BRAND)).toBe(false);
  });
});

describe("detectLink", () => {
  it("requires a resolvable http(s) URL to an owned domain", () => {
    expect(detectLink(sample({ citations: [{ url: "https://mesh-ai.dev" }] }), BRAND)).toBe(true);
    // Owned domain, but cited by bare domain with no URL -> cited, not linked.
    expect(detectLink(sample({ citations: [{ domain: "mesh-ai.dev" }] }), BRAND)).toBe(false);
  });
});

describe("path-aware owned sources (regression: shared-host over-counting)", () => {
  // BRAND owns "https://github.com/org/mesh" — a path on a shared host, not all
  // of github.com. A different repo on the same host must NOT count as owned.
  const meshRepo = { url: "https://github.com/org/mesh/tree/main/packages" };
  const otherRepo = { url: "https://github.com/someone-else/their-project" };

  it("counts the brand's own repo as cited/linked", () => {
    expect(detectCitation(sample({ citations: [meshRepo] }), BRAND)).toBe(true);
    expect(detectLink(sample({ citations: [meshRepo] }), BRAND)).toBe(true);
  });

  it("does NOT count an unrelated repo on the same host as owned/cited/linked", () => {
    expect(detectCitation(sample({ citations: [otherRepo] }), BRAND)).toBe(false);
    expect(detectLink(sample({ citations: [otherRepo] }), BRAND)).toBe(false);
    const overlap = scoreSourceOverlap(sample({ citations: [otherRepo] }), BRAND);
    expect(overlap.citedDomains).toEqual(["github.com"]);
    expect(overlap.ownedDomainsCited).toEqual([]); // host cited, but not an owned path
    expect(overlap.overlapRatio).toBe(0);
  });
});

describe("detectCategoryAssociations", () => {
  it("associates categories only when the brand is mentioned", () => {
    const s = sample({ text: "MESH does llm routing and semantic caching." });
    expect(detectCategoryAssociations(s, BRAND, true).sort()).toEqual(["caching", "routing"]);
    expect(detectCategoryAssociations(s, BRAND, false)).toEqual([]);
  });

  it("does not associate a keyword that sits far from any brand mention", () => {
    // Keyword is >220 chars from the only mention -> not an association.
    const far = `MESH is a tool. ${"filler ".repeat(60)} semantic caching is unrelated here.`;
    expect(detectCategoryAssociations(sample({ text: far }), BRAND, true)).toEqual([]);
  });
});

describe("scoreFactualDescription", () => {
  it("is correct when a claim is supported and none contradicted", () => {
    const s = sample({ text: "MESH is an AI cost engineering tool that optimises inference without compromising quality." });
    const r = scoreFactualDescription(s, BRAND, true);
    expect(r.present).toBe(true);
    expect(r.correct).toBe(true);
    expect(r.supportedClaims.sort()).toEqual(["category", "quality"]);
    expect(r.contradictedClaims).toEqual([]);
  });

  it("is present-but-incorrect when a claim is contradicted (wrong-entity confusion)", () => {
    const s = sample({ text: "MESH is a mesh wifi system for your home." });
    const r = scoreFactualDescription(s, BRAND, true);
    expect(r.present).toBe(true);
    expect(r.correct).toBe(false);
    expect(r.contradictedClaims).toEqual(["category"]);
  });

  it("is absent when the brand is not mentioned", () => {
    expect(scoreFactualDescription(sample({ text: "ai cost engineering" }), BRAND, false).present).toBe(false);
  });
});

describe("scoreSourceOverlap", () => {
  it("computes the owned fraction of unique cited domains", () => {
    const s = sample({
      citations: [
        { url: "https://mesh-ai.dev/a" },
        { url: "https://mesh-ai.dev/b" }, // same domain -> counted once
        { url: "https://openai.com/x" },
      ],
    });
    const r = scoreSourceOverlap(s, BRAND);
    expect(r.citedDomains.sort()).toEqual(["mesh-ai.dev", "openai.com"]);
    expect(r.ownedDomainsCited).toEqual(["mesh-ai.dev"]);
    expect(r.overlapRatio).toBeCloseTo(0.5, 6);
  });

  it("returns a null ratio when nothing was cited", () => {
    expect(scoreSourceOverlap(sample({ citations: [] }), BRAND).overlapRatio).toBeNull();
  });
});

describe("detectCompetitors", () => {
  it("lists competitor brands present in the text", () => {
    const s = sample({ text: "Alternatives include OpenRouter and LiteLLM." });
    expect(detectCompetitors(s, BRAND).sort()).toEqual(["LiteLLM", "OpenRouter"]);
  });
});

describe("scoreAnswer", () => {
  it("assembles all six signals for a strong answer", () => {
    const s = sample({
      queryId: "q-cost",
      categories: ["routing"],
      text: "MESH is an AI cost engineering platform doing llm routing without compromising quality.",
      citations: [{ url: "https://mesh-ai.dev/docs" }, { url: "https://openai.com" }],
    });
    const m = scoreAnswer(s, BRAND, ctx);
    expect(m.mentioned).toBe(true);
    expect(m.cited).toBe(true);
    expect(m.linked).toBe(true);
    expect(m.categoriesAssociated).toEqual(["routing"]);
    expect(m.factualDescription.correct).toBe(true);
    expect(m.sourceOverlap.overlapRatio).toBeCloseTo(0.5, 6);
    expect(m.queryId).toBe("q-cost");
    expect(m.categoriesProbed).toEqual(["routing"]);
    expect(m.runId).toBe("run-0");
  });

  it("scores an errored sample as all-negative but keeps query metadata", () => {
    const m = scoreAnswer(sample({ queryId: "q1", categories: ["routing"], error: "timeout" }), BRAND, ctx);
    expect(m.mentioned).toBe(false);
    expect(m.cited).toBe(false);
    expect(m.linked).toBe(false);
    expect(m.factualDescription.present).toBe(false);
    expect(m.sourceOverlap.overlapRatio).toBeNull();
    expect(m.error).toBe("timeout");
    expect(m.categoriesProbed).toEqual(["routing"]);
  });

  it("falls back to the query string when no queryId is given", () => {
    const m = scoreAnswer(sample({ query: "q-text" }), BRAND, ctx);
    expect(m.queryId).toBe("q-text");
  });
});
