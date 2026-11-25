// FICTIONAL fixtures for the tests and for `gtm demo`.
//
// Nothing here describes a real organisation, page, person or result. The
// names are invented, the web addresses are on reserved example domains
// (RFC 2606), and every source is marked as a fixture. They exist so the
// engine can be shown working without touching the real, private store.

import type { NumbersIndex } from "./claims.js";
import type { GtmStore } from "./store.js";
import type { DataOf, GtmRecord, Source } from "./types.js";

export const FICTIONAL_NOTE = "FICTIONAL fixture: not a real page";

export function fictionalSource(path = "post", readOn = "2026-11-20"): Source {
  return { url: `https://example.com/fictional/${path}`, readOn, note: FICTIONAL_NOTE };
}

/** Stands in for docs/NUMBERS.md in tests: one LIVE figure and one SIMULATOR figure. */
export const FIXTURE_NUMBERS: NumbersIndex = { live: ["18.2%"], simulator: ["57.7%"], reconciled: "2026-10-27" };

export function fictionalProspect(overrides: Partial<DataOf<"prospect">> = {}): DataOf<"prospect"> {
  return {
    organisation: "Example Agents Ltd",
    website: "https://example-agents.example",
    organisationType: "company",
    useCase: "A fictional company running a tool-calling support agent on a provider API with its own key.",
    publicSignals: [{ summary: "Fictional engineering post about the cost of re-sent agent context.", url: "https://example.com/fictional/agent-costs", readOn: "2026-11-20" }],
    contactStatus: "not-contacted",
    contactRoutes: [{ type: "contact-page", url: "https://example-agents.example/contact", verified: "unknown" }],
    collection: { source: "https://example.com/fictional/agent-costs", collectedOn: "2026-11-20" },
    lawfulBasis: { basis: "not-assessed", note: "Not assessed yet." },
    optOut: false,
    sourceStatus: "unverified",
    ...overrides,
  };
}

export const FICTIONAL_QUALIFICATION: NonNullable<DataOf<"prospect">["qualification"]> = {
  score: 70,
  reasons: [
    { criterion: "Runs a tool-calling agent on a provider API with its own key", points: 40, evidence: "Fictional post, example.com/fictional/agent-costs" },
    { criterion: "Has written publicly about agent cost", points: 30, evidence: "Fictional post, example.com/fictional/agent-costs" },
  ],
  scoredOn: "2026-11-21",
};

/** Walk a fictional prospect to "qualified" the way the outbound agent would. */
export function qualifiedProspect(store: GtmStore, overrides: Partial<DataOf<"prospect">> = {}): GtmRecord<"prospect"> {
  const created = store.create("outbound", "prospect", fictionalProspect(overrides), { sources: [fictionalSource("agent-costs")] });
  store.transition("outbound", created.id, "researched", { note: "Fictional research." });
  return store.transition<"prospect">("outbound", created.id, "qualified", {
    patch: {
      qualification: FICTIONAL_QUALIFICATION,
      lawfulBasis: { basis: "no-personal-data", note: "Organisation-level public business information only; no person is named." },
    },
    note: "Fictional qualification.",
  });
}

export function fictionalOutreach(prospectId: string, overrides: Partial<DataOf<"outreach-draft">> = {}): DataOf<"outreach-draft"> {
  return {
    prospectId,
    route: { type: "contact-page", url: "https://example-agents.example/contact", verified: "unknown" },
    subject: "A ledger for what your agent's context costs",
    body:
      "Your post describes the cost of context your agent sends again on every turn. Mesh is a local proxy that records, in a ledger on your own disk, " +
      "what each request cost and what was removed from it without changing what the model reads. You can check every entry yourself. " +
      "If the ledger shows nothing worth having on your traffic, it says so. (Fictional fixture text.)",
    figures: [],
    ...overrides,
  };
}

export function fictionalContent(overrides: Partial<DataOf<"content-item">> = {}): DataOf<"content-item"> {
  return {
    title: "Fictional: why an agent pays for the same context twice",
    topic: "re-sent agent context",
    format: "page",
    targetQueryIds: [],
    ...overrides,
  };
}

/** Walk a fictional content item to "review" with a passing fact-check and review. */
export function reviewedContent(store: GtmStore): GtmRecord<"content-item"> {
  const item = store.create("content", "content-item", fictionalContent());
  store.transition("content", item.id, "brief", { patch: { researchNotes: "Fictional notes." } });
  store.transition("content", item.id, "draft", {
    patch: { brief: { audience: "Engineers running agents", question: "Why does my agent's bill grow with each turn?", angle: "Show the mechanism.", mustInclude: [], sourcesToUse: [] } },
  });
  store.transition("content", item.id, "fact-check", { patch: { draft: { body: "Fictional draft with no figures in it.", figures: [] } } });
  store.transition("geo-seo", item.id, "review", { patch: { factCheck: { verdict: "pass", checkedOn: "2026-11-22", claimsChecked: 3, issues: [] } } });
  return store.update<"content-item">("growth-director", item.id, { review: { verdict: "pass", notes: "Fictional review." } });
}

export function fictionalCommunity(): DataOf<"community-opportunity"> {
  return {
    venue: "Example Forum",
    url: "https://forum.example.org/fictional/thread-1",
    topic: "How do people track what an agent's context costs?",
    type: "question",
    relevance: "A fictional thread asking the question Mesh's ledger answers.",
  };
}

export function fictionalPartnership(): DataOf<"partnership"> {
  return {
    organisation: "Example Registry",
    website: "https://registry.example.org",
    type: "registry-listing",
    rationale: "A fictional registry that coding agents read when choosing tools.",
  };
}
