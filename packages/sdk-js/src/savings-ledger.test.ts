import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogueVersion,
  publishedModelPrices,
  recomputeInvoice,
  recomputeInvoiceWithAudit,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { withMesh } from "./openai.js";
import { billableEventFromRequest, createSavingsLedger } from "./savings-ledger.js";
import type { MeshRequestEvent } from "./types.js";

type AnyObject = Record<string, any>;

function stubClient(response: AnyObject) {
  return {
    responses: {
      create: async (_request: AnyObject) => structuredClone(response),
    },
  };
}

const flexResponse = {
  output_text: "ok",
  service_tier: "batch",
  usage: {
    input_tokens: 1_000_000,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  },
};

function requestEvent(overrides: Partial<MeshRequestEvent>): MeshRequestEvent {
  return {
    requestId: "req-1",
    applicationId: "app",
    provider: "openai-compatible",
    model: "gpt-6-astra",
    latencyMs: 1,
    status: "succeeded",
    timestamp: "2026-10-13T10:00:00.000Z",
    inputTokens: 1_000_000,
    outputTokens: 0,
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    ...overrides,
  };
}

describe("createSavingsLedger wired into withMesh", () => {
  it("appends one hash-chained billable event per request, priced from the RESPONSE tier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const path = join(dir, "ledger.jsonl");
    const client = withMesh(stubClient(flexResponse), {
      applicationId: "meter-test",
      ledger: { path, provider: "openai" },
    });
    const response = await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    expect(response.output_text).toBe("ok");

    const records: LedgerRecord[] = readFileSync(path, "utf8")
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(1);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 1 });
    const billed = records[0]!.event;
    expect(billed.executionMode).toBe("batch");
    expect(billed.pricingStatus).toBe("priced");
    expect(billed.actualUsd).toBe(5);
    expect(billed.catalogueVersion).toBe(catalogueVersion(publishedModelPrices));
    expect(billed.levers).toEqual([{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 5 }]);

    // The spool replayed twice recomputes to the same invoice (idempotent by requestId).
    const { invoice, audit } = recomputeInvoiceWithAudit([billed, billed]);
    expect(audit.duplicatesIgnored).toBe(1);
    expect(invoice.netVerifiedSavingsUsd).toBe(5);
  });

  it("resumes the chain across ledger instances instead of restarting at genesis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const path = join(dir, "ledger.jsonl");
    for (let run = 0; run < 2; run += 1) {
      const client = withMesh(stubClient(flexResponse), {
        applicationId: "meter-test",
        ledger: { path, provider: "openai" },
      });
      await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    }
    const records: LedgerRecord[] = readFileSync(path, "utf8")
      .split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerRecord);
    expect(records).toHaveLength(2);
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 2 });
  });

  it("never throws into the request path: an unwritable spool leaves the response untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "occupied", "utf8");
    const client = withMesh(stubClient(flexResponse), {
      applicationId: "meter-test",
      // Parent "directory" is a regular file, so every append fails.
      ledger: { path: join(blocker, "ledger.jsonl") },
    });
    const response = await client.responses.create({ model: "gpt-6-astra", input: "hi" });
    expect(response.output_text).toBe("ok");
  });

  it("goes quiet rather than extending a corrupt chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-ledger-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "{not json\n", "utf8");
    const ledger = createSavingsLedger({ path });
    ledger.emit(requestEvent({}));
    expect(readFileSync(path, "utf8")).toBe("{not json\n");
  });
});

describe("billableEventFromRequest", () => {
  const version = catalogueVersion(publishedModelPrices);

  it("bills zero tier savings when a flex request fell back: the response tier is standard", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        responseServiceTier: "default",
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "execution-tier-flex", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    expect(billed.executionMode).toBe("standard");
    expect(billed.levers.filter((lever) => lever.kind === "tier")).toHaveLength(0);
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0);
  });

  it("records the exact-cache avoidance at the originally measured cost", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        cacheHit: true,
        costAvoidedUsd: 0.42,
        inputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      }),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    expect(billed.actualUsd).toBe(0);
    expect(billed.levers).toContainEqual({ leverId: "exact-response-cache", kind: "exact_cache", savedUsd: 0.42 });
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0.42);
  });

  it("nets the 1h cache stamp's write surcharge as negative savings when no reads earn it back", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "cache-ttl-1h", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    // No TTL split reported on a MESH-placed stamp: every write prices at the
    // 1h premium (Sonnet 5.5: 4/M vs input 2/M), the dispute-safe reading.
    expect(billed.levers).toContainEqual({ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -2 });
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBeCloseTo(-2, 10);
  });

  it("excludes cache discounts the customer already had instead of billing them", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 0, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 0,
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    expect(billed.excluded?.providerCacheAlreadyOwnedUsd).toBeCloseTo(1.9, 10);
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0);
  });

  it("bills the measured counterfactual delta only when every applied lossy lever is gate-approved", () => {
    const base = requestEvent({
      reduction: {
        estimatedTokensBefore: 2_000_000, estimatedTokensAfter: 1_000_000, estimatedTokensSaved: 1_000_000,
        estimatedLosslessTokensSaved: 0, skipped: false,
        changes: [{ lever: "fresh-tool-result-cap", lossless: false, estimatedTokensSaved: 1_000_000, detail: "" }],
      },
    });
    const approved = billableEventFromRequest(
      base,
      {
        path: "unused",
        getBaselineUsd: () => 20,
        gateVerdicts: { "fresh-tool-result-cap": { ref: "replay-gate/freshcap@cbbffb9", verdict: "approved" } },
      },
      publishedModelPrices,
      version,
    );
    // baseline 20 USD minus actual 10 USD (1M input at gpt-6-astra standard).
    expect(recomputeInvoice([approved]).netVerifiedSavingsUsd).toBe(10);

    const unapproved = billableEventFromRequest(
      base,
      { path: "unused", getBaselineUsd: () => 20 },
      publishedModelPrices,
      version,
    );
    expect(recomputeInvoice([unapproved]).netVerifiedSavingsUsd).toBe(0);
  });

  it("stores the correlation so a failed task's turns can be excluded", () => {
    const turn = (requestId: string, turnIndex: number, status: "succeeded" | "failed") =>
      billableEventFromRequest(
        requestEvent({ requestId, status, responseServiceTier: "batch" }),
        { path: "unused", getCorrelation: () => ({ taskId: "task-1", turnIndex }) },
        publishedModelPrices,
        version,
      );
    const events = [turn("r1", 1, "succeeded"), turn("r2", 2, "succeeded"), turn("r3", 4, "failed")];
    expect(events[0]!.taskId).toBe("task-1");
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(0);
    expect(invoice.eventsExcludedForFailedTasks).toBe(3);
  });
});

describe("estimated-baseline billing for token-reduction levers", () => {
  const version = catalogueVersion(publishedModelPrices);
  // gpt-6-astra standard input is 10 USD/M. The event's provider-verbatim input
  // is 800k uncached tokens; MESH's own counter says it removed 200k of a 1M
  // request (fraction 0.2), so baseline input = 800k / 0.8 = 1M, saved = 200k,
  // valued at the realized input rate 10 USD/M => 2 USD, split 3:1 by lever.
  const reducedEvent = (losslessCap: boolean) => requestEvent({
    inputTokens: 800_000, uncachedInputTokens: 800_000,
    reduction: {
      estimatedTokensBefore: 1_000_000, estimatedTokensAfter: 800_000, estimatedTokensSaved: 200_000,
      estimatedLosslessTokensSaved: losslessCap ? 200_000 : 150_000, skipped: false,
      changes: [
        { lever: "tool-schemas", lossless: true, estimatedTokensSaved: 150_000, detail: "" },
        { lever: "fresh-tool-result-cap", lossless: losslessCap, estimatedTokensSaved: 50_000, detail: "" },
      ],
    },
  });

  it("bills lossless levers from the ratio-anchored estimate at the realized input rate, labelled", () => {
    const billed = billableEventFromRequest(reducedEvent(true), { path: "unused" }, publishedModelPrices, version);
    const schemas = billed.levers.find((lever) => lever.leverId === "tool-schemas");
    const cap = billed.levers.find((lever) => lever.leverId === "fresh-tool-result-cap");
    expect(schemas?.savedUsd).toBeCloseTo(1.5, 10);
    expect(cap?.savedUsd).toBeCloseTo(0.5, 10);
    expect(schemas?.basis).toBe("estimated-baseline");
    expect(billed.estimatedReduction).toEqual({
      estimatedInputTokensBefore: 1_000_000,
      estimatedInputTokensRemoved: 200_000,
    });
    const invoice = recomputeInvoice([billed]);
    expect(invoice.netVerifiedSavingsUsd).toBeCloseTo(2, 10);
    expect(invoice.lineItems.every((line) => line.basis === "estimated-baseline")).toBe(true);
  });

  // The real request of 2026-11-25: Claude Code through MESH on Sonnet 5.5
  // (2 USD/M input, 0.10 cache read, 4 one-hour cache write). MESH's counter
  // saw 837 of 45,782 tokens removed from the tool definitions; the provider
  // billed 50,796 input tokens, 48,304 of them from the cache. Against an
  // unreduced control the provider's own counts showed 806 tokens, 0.000081
  // USD warm. The blended rate used to claim 0.000183 USD.
  const claudeCodeEvent = (usage: Partial<MeshRequestEvent>) => requestEvent({
    provider: "anthropic", model: "claude-sonnet-5-5", timestamp: "2026-11-25T21:32:51.000Z",
    inputTokens: 50_796, outputTokens: 4, uncachedInputTokens: 2_492,
    ...usage,
    reduction: {
      estimatedTokensBefore: 45_782, estimatedTokensAfter: 44_945, estimatedTokensSaved: 837,
      estimatedLosslessTokensSaved: 837, skipped: false,
      changes: [{ lever: "tool-schema-compaction", lossless: true, estimatedTokensSaved: 837, detail: "" }],
    },
  });
  const compaction = (usage: Partial<MeshRequestEvent>) =>
    billableEventFromRequest(claudeCodeEvent(usage), { path: "unused", provider: "anthropic" }, publishedModelPrices, version)
      .levers.find((lever) => lever.leverId === "tool-schema-compaction");

  it("values removed tool-definition tokens at the cache-read rate on a warm request", () => {
    const lever = compaction({ cachedInputTokens: 48_304, cacheWriteInputTokens: 0 });
    expect(lever?.savedUsd).toBeCloseTo(837 * 0.10 / 1_000_000, 12);
    expect(lever?.basis).toBe("estimated-baseline");
    expect(lever?.detail).toBe("837 tool-definition tokens at the rate the front of the prompt was billed");
  });

  it("values them at the write rate on a cold request and the fresh rate with no cache", () => {
    const cold = compaction({
      cachedInputTokens: 0, cacheWriteInputTokens: 48_304, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 48_304,
    });
    expect(cold?.savedUsd).toBeCloseTo(837 * 4 / 1_000_000, 12);
    const uncached = compaction({ cachedInputTokens: 0, cacheWriteInputTokens: 0, uncachedInputTokens: 50_796 });
    expect(uncached?.savedUsd).toBeCloseTo(837 * 2 / 1_000_000, 12);
  });

  it("keeps a lossy lever's estimated share unbilled until a replay gate approves it", () => {
    const unapproved = billableEventFromRequest(reducedEvent(false), { path: "unused" }, publishedModelPrices, version);
    expect(recomputeInvoice([unapproved]).netVerifiedSavingsUsd).toBeCloseTo(1.5, 10);

    const approved = billableEventFromRequest(
      reducedEvent(false),
      { path: "unused", gateVerdicts: { "fresh-tool-result-cap": { ref: "replay-gate/freshcap@cbbffb9", verdict: "approved" } } },
      publishedModelPrices,
      version,
    );
    expect(recomputeInvoice([approved]).netVerifiedSavingsUsd).toBeCloseTo(2, 10);
  });

  it("voids the estimate entirely when the removed fraction is implausible (>= 0.95)", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        inputTokens: 50_000, uncachedInputTokens: 50_000,
        reduction: {
          estimatedTokensBefore: 1_000_000, estimatedTokensAfter: 40_000, estimatedTokensSaved: 960_000,
          estimatedLosslessTokensSaved: 960_000, skipped: false,
          changes: [{ lever: "tool-schemas", lossless: true, estimatedTokensSaved: 960_000, detail: "" }],
        },
      }),
      { path: "unused" },
      publishedModelPrices,
      version,
    );
    expect(billed.levers.find((lever) => lever.leverId === "tool-schemas")?.savedUsd).toBeUndefined();
    expect(billed.estimatedReduction).toBeUndefined();
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBe(0);
  });

  it("never double-counts: a supplied measured counterfactual replaces the estimate", () => {
    const billed = billableEventFromRequest(
      reducedEvent(true),
      { path: "unused", getBaselineUsd: () => 20 },
      publishedModelPrices,
      version,
    );
    expect(billed.levers.find((lever) => lever.leverId === "tool-schemas")?.savedUsd).toBeUndefined();
    expect(billed.estimatedReduction).toBeUndefined();
    // Bills exactly baseline minus actual (800k input at 10/M = 8), once.
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBeCloseTo(12, 10);
  });
});

describe("5m cacheTtl stamp billing", () => {
  const version = catalogueVersion(publishedModelPrices);

  it("prices MESH-placed 5m writes at the 5m premium when the provider reports no split", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "cache-ttl-5m", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    // A 5m stamp can only have produced 5m writes: 1M at Sonnet 5.5's 2.5/M,
    // never the 1h 4/M that a MESH-placed 1h stamp conservatively assumes.
    expect(billed.actualUsd).toBeCloseTo(2.5, 10);
    const lever = billed.levers.find((l) => l.leverId === "cache-ttl-5m")!;
    expect(lever.kind).toBe("provider_cache");
    // All writes, no reads: 2 full-rate minus 2.5 written = -0.5, netted.
    expect(lever.savedUsd).toBeCloseTo(-0.5, 10);
  });

  it("earns positive attributed savings when reads outweigh the 5m write premium", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 100_000, cachedInputTokens: 900_000, cacheWriteInputTokens: 0,
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "cache-ttl-5m", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    // 900K reads at 0.1/M instead of 2/M: 1.8 full-rate avoided minus 0.09 paid.
    const lever = billed.levers.find((l) => l.leverId === "cache-ttl-5m")!;
    expect(lever.savedUsd).toBeCloseTo(1.71, 10);
    expect(recomputeInvoice([billed]).netVerifiedSavingsUsd).toBeCloseTo(1.71, 10);
  });

  it("fails closed rather than dropping a malformed provider TTL split", () => {
    const billed = billableEventFromRequest(
      requestEvent({
        model: "claude-sonnet-5-5-20260514",
        inputTokens: 1_000_000, uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        cacheWrite5mInputTokens: -1,
        cacheWrite1hInputTokens: 1_000_001,
        reduction: {
          estimatedTokensBefore: 10, estimatedTokensAfter: 10, estimatedTokensSaved: 0,
          estimatedLosslessTokensSaved: 0, skipped: false,
          changes: [{ lever: "cache-ttl-5m", lossless: true, estimatedTokensSaved: 0, detail: "" }],
        },
      }),
      { path: "unused", provider: "anthropic" },
      publishedModelPrices,
      version,
    );
    expect(billed.pricingStatus).toBe("unpriced");
    expect(billed.actualUsd).toBeUndefined();
  });
});
