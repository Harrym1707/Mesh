import { describe, expect, it } from "vitest";
import { catalogueVersion, validatePriceCatalogue, type PriceCatalogue } from "./price-catalogue.js";
import { publishedModelPrices } from "./model-prices.js";
import {
  auditEventPricing,
  chainLedgerRecord,
  feeCents,
  priceLedgerUsage,
  recomputeInvoice,
  recomputeInvoiceWithAudit,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "./savings-ledger.js";

function event(overrides: Partial<BillableEvent> & { requestId: string }): BillableEvent {
  return {
    schemaVersion: 1,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-13T10:00:00.000Z",
    provider: "openai",
    model: "gpt-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [],
    status: "succeeded",
    ...overrides,
  };
}

describe("recomputeInvoice", () => {
  it("is deterministic: same events, shuffled or replayed twice, yield a byte-identical invoice", () => {
    const events = [
      event({ requestId: "b", levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1.25 }] }),
      event({ requestId: "a", levers: [{ leverId: "exact-response-cache", kind: "exact_cache", savedUsd: 0.4 }] }),
      event({ requestId: "c", levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -0.1 }] }),
    ];
    const first = JSON.stringify(recomputeInvoice(events));
    const shuffled = JSON.stringify(recomputeInvoice([events[2]!, events[0]!, events[1]!]));
    const replayedTwice = JSON.stringify(recomputeInvoice([...events, ...events]));
    expect(shuffled).toBe(first);
    expect(replayedTwice).toBe(first);
    // Replay metadata lives in the audit object, never in the canonical
    // invoice: a doubled spool must be byte-identical billing, and the audit
    // trail still shows the replays were seen and dropped.
    expect(recomputeInvoiceWithAudit([...events, ...events]).audit.duplicatesIgnored).toBe(3);
    expect(recomputeInvoiceWithAudit(events).audit.duplicatesIgnored).toBe(0);
    // A spool replayed 25 hours late carries the same per-event invoicePeriod
    // stamps, so the period query result cannot drift either.
    const late = JSON.stringify(recomputeInvoice([...events, ...events], { period: "2026-10" }));
    const onTime = JSON.stringify(recomputeInvoice(events, { period: "2026-10" }));
    expect(late).toBe(onTime);
  });

  it("nets negative savings instead of clamping, and returns do_not_charge when nothing is owed", () => {
    const events = [
      event({ requestId: "r1", levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -0.5 }] }),
      event({ requestId: "r2", levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: 0.2 }] }),
    ];
    const invoice = recomputeInvoice(events, { feePercent: 25 });
    expect(invoice.netVerifiedSavingsUsd).toBeCloseTo(-0.3, 10);
    expect(invoice.lineItems[0]!.savedUsd).toBeCloseTo(-0.3, 10);
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.amountDueUsd).toBe(0);
  });

  it("never bills the customer's existing savings (provider cache on history, gateway cache)", () => {
    const events = [
      event({
        requestId: "r1",
        levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1 }],
        excluded: { providerCacheAlreadyOwnedUsd: 3.7, gatewayCacheUsd: 2.2 },
      }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(1);
    expect(invoice.excludedAlreadyOwned.providerCacheOnAppendedHistoryUsd).toBe(3.7);
    expect(invoice.excludedAlreadyOwned.gatewayCacheUsd).toBe(2.2);
  });

  it("bills a lossy lever only with an approved gate verdict, and an override flips it off without event mutation", () => {
    const events = [
      event({
        requestId: "r1",
        levers: [{
          leverId: "fresh-tool-result-cap",
          kind: "lossy",
          savedUsd: 2,
          gateVerdict: { ref: "replay-gate/freshcap@cbbffb9", verdict: "approved" },
        }],
      }),
      event({
        requestId: "r2",
        levers: [{ leverId: "output-cap", kind: "lossy", savedUsd: 5 }],
      }),
    ];
    const serialized = JSON.stringify(events);
    const approved = recomputeInvoice(events);
    expect(approved.netVerifiedSavingsUsd).toBe(2);
    expect(approved.lineItems[0]!.gateVerdictRefs).toEqual(["replay-gate/freshcap@cbbffb9"]);
    expect(approved.recordedUnbilled).toEqual([
      { leverId: "output-cap", kind: "lossy", events: 1, reason: "no approved replay gate verdict" },
    ]);
    const flipped = recomputeInvoice(events, {
      gateVerdictOverrides: { "fresh-tool-result-cap": "rejected" },
    });
    expect(flipped.netVerifiedSavingsUsd).toBe(0);
    expect(flipped.verdict).toBe("do_not_charge");
    expect(JSON.stringify(events)).toBe(serialized);
  });

  it("records levers without a verified per-request measurement but never bills them", () => {
    const events = [
      event({ requestId: "r1", levers: [{ leverId: "tool-schema-compaction", kind: "lossless" }] }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(0);
    expect(invoice.recordedUnbilled[0]!.reason).toBe("no per-request verified measurement");
  });

  it("excludes every turn of a task that failed, including turns that appeared to save", () => {
    const events = [
      event({ requestId: "t1", taskId: "task-9", turnIndex: 1, levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 1 }] }),
      event({ requestId: "t2", taskId: "task-9", turnIndex: 4, status: "failed", levers: [] }),
      event({ requestId: "ok", taskId: "task-10", levers: [{ leverId: "execution-tier-flex", kind: "tier", savedUsd: 0.5 }] }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.netVerifiedSavingsUsd).toBe(0.5);
    expect(invoice.failedTaskIds).toEqual(["task-9"]);
    expect(invoice.eventsExcludedForFailedTasks).toBe(2);
    // Out-of-band quality failure (graded after the fact) excludes the same way.
    const graded = recomputeInvoice(events, { failedTaskIds: ["task-10"] });
    expect(graded.netVerifiedSavingsUsd).toBe(0);
  });

  it("filters by the period stamped on each event at write time", () => {
    const events = [
      event({ requestId: "r1", invoicePeriod: "2026-09", levers: [{ leverId: "x", kind: "tier", savedUsd: 1 }] }),
      event({ requestId: "r2", invoicePeriod: "2026-10", levers: [{ leverId: "x", kind: "tier", savedUsd: 2 }] }),
    ];
    expect(recomputeInvoice(events, { period: "2026-09" }).netVerifiedSavingsUsd).toBe(1);
    expect(recomputeInvoice(events, { period: "2026-10" }).netVerifiedSavingsUsd).toBe(2);
  });
});

describe("ledger hash chain", () => {
  it("verifies an intact chain and names the exact record that was perturbed", () => {
    const records: LedgerRecord[] = [];
    for (const id of ["a", "b", "c"]) {
      records.push(chainLedgerRecord(
        event({ requestId: id, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0 } }),
        records[records.length - 1],
      ));
    }
    expect(verifyLedgerChain(records)).toEqual({ ok: true, length: 3 });
    const perturbed = structuredClone(records);
    perturbed[1]!.event.usage!.inputTokens = 11;
    const verdict = verifyLedgerChain(perturbed);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.seq).toBe(1);
    const reordered = [records[0]!, records[2]!, records[1]!];
    expect(verifyLedgerChain(reordered).ok).toBe(false);
  });
});

describe("priceLedgerUsage", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };

  it("prices the execution-tier delta from catalogued rates on actual tokens", () => {
    const priced = priceLedgerUsage(publishedModelPrices, {
      provider: "openai",
      model: "gpt-6-astra",
      at: "2026-10-13",
      executionMode: "batch",
      usage,
      meshPlacedCacheControl: false,
    });
    expect(priced).toEqual({ pricingStatus: "priced", actualUsd: 5, inputUsd: 5, tierSavedUsd: 5 });
  });

  it("returns unpriced, never zero, when the actual mode has no catalogued rate", () => {
    const priced = priceLedgerUsage(publishedModelPrices, {
      provider: "openai",
      // gpt-4o has no flex rate catalogued (gpt-5 does), so flex must be unpriced.
      model: "gpt-4o",
      at: "2026-10-13",
      executionMode: "flex",
      usage,
      meshPlacedCacheControl: false,
    });
    expect(priced.pricingStatus).toBe("unpriced");
  });

  it("attributes cache economics to MESH only when MESH placed the cache_control, writes netted negative", () => {
    const writeHeavy = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000 };
    const meshPlaced = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: writeHeavy,
      meshPlacedCacheControl: true,
    });
    // MESH stamped the 1h TTL and the provider reported no TTL split, so EVERY
    // write prices at the 1h premium (Sonnet 5.5: 4 vs input 2 per million) -
    // the dispute-safe reading. All writes, no reads => the surcharge shows as
    // NEGATIVE attributed savings, not clamped.
    expect(meshPlaced).toEqual({ pricingStatus: "priced", actualUsd: 4, inputUsd: 4, cacheAttributedUsd: -2 });

    // A reported split prices each bucket at its own rate: 5m at 1.25x, 1h at 2x.
    const splitReported = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: {
        inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        cacheWrite5mInputTokens: 600_000, cacheWrite1hInputTokens: 400_000,
      },
      meshPlacedCacheControl: true,
    });
    // 0.6M at 2.5 + 0.4M at 4 = 1.5 + 1.6 = 3.1 USD.
    expect(splitReported).toEqual({ pricingStatus: "priced", actualUsd: 3.1, inputUsd: 3.1, cacheAttributedUsd: -1.1 });

    // A split that does not sum to the total is a provider-usage inconsistency:
    // the event is unpriced, never silently repaired.
    const mismatch = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: {
        inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000,
        cacheWrite5mInputTokens: 600_000, cacheWrite1hInputTokens: 100_000,
      },
      meshPlacedCacheControl: true,
    });
    expect(mismatch.pricingStatus).toBe("unpriced");

    const customerOwned = priceLedgerUsage(publishedModelPrices, {
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      at: "2026-10-13",
      executionMode: "standard",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 0 },
      meshPlacedCacheControl: false,
    });
    expect(customerOwned).toEqual({
      pricingStatus: "priced",
      actualUsd: 0.1,
      inputUsd: 0.1,
      providerCacheAlreadyOwnedUsd: 1.9,
    });
  });
});

describe("catalogue pinning", () => {
  it("hashes catalogue content, so a rate change changes the version", () => {
    const bumped: PriceCatalogue = validatePriceCatalogue(structuredClone(publishedModelPrices));
    bumped.entries[0]!.tiers[0]!.inputPerMillion += 1;
    expect(catalogueVersion(bumped)).not.toBe(catalogueVersion(publishedModelPrices));
    expect(catalogueVersion(publishedModelPrices)).toBe(catalogueVersion(structuredClone(publishedModelPrices)));
  });

  it("leaves historical invoices unchanged when the catalogue is bumped, and the audit names the version mismatch", () => {
    const version = catalogueVersion(publishedModelPrices);
    const events = [event({
      requestId: "r1",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      catalogueVersion: version,
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 5,
      levers: [{ leverId: "execution-tier-batch", kind: "tier", savedUsd: 5 }],
    })];
    const before = JSON.stringify(recomputeInvoice(events));
    expect(auditEventPricing(events[0]!, publishedModelPrices)).toEqual({ status: "verified" });

    const bumped: PriceCatalogue = validatePriceCatalogue(structuredClone(publishedModelPrices));
    bumped.entries[0]!.tiers[0]!.inputPerMillion += 1;
    // The invoice reads only stored, version-pinned figures: byte-identical after the bump.
    expect(JSON.stringify(recomputeInvoice(events))).toBe(before);
    const audit = auditEventPricing(events[0]!, bumped);
    expect(audit.status).toBe("catalogue_version_mismatch");
  });

  it("re-audits a 5m cache stamp at the TTL recorded on the event", () => {
    const stamped = event({
      requestId: "cache-5m",
      provider: "anthropic",
      model: "claude-sonnet-5-5-20260514",
      catalogueVersion: catalogueVersion(publishedModelPrices),
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 1_000_000 },
      actualUsd: 2.5,
      levers: [{ leverId: "cache-ttl-5m", kind: "provider_cache", savedUsd: -0.5 }],
    });
    expect(auditEventPricing(stamped, publishedModelPrices)).toEqual({ status: "verified" });
  });

  it("flags a stored cost that the pinned catalogue cannot reproduce, with zero tolerance", () => {
    const tampered = event({
      requestId: "r1",
      provider: "openai",
      model: "gpt-6-astra",
      executionMode: "batch",
      catalogueVersion: catalogueVersion(publishedModelPrices),
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      actualUsd: 4.999999,
      levers: [],
    });
    const audit = auditEventPricing(tampered, publishedModelPrices);
    expect(audit.status).toBe("mismatch");
  });
});

describe("estimated-baseline labelling", () => {
  it("labels a line item estimated-baseline when any contributing lever's savedUsd was estimated", () => {
    const events = [
      event({
        requestId: "r1",
        levers: [{ leverId: "tool-schemas", kind: "lossless", savedUsd: 1.5, basis: "estimated-baseline" }],
      }),
      event({
        requestId: "r2",
        levers: [{ leverId: "tool-schemas", kind: "lossless", savedUsd: 0.5 }],
      }),
    ];
    const invoice = recomputeInvoice(events);
    expect(invoice.lineItems).toHaveLength(1);
    expect(invoice.lineItems[0]).toMatchObject({
      leverId: "tool-schemas",
      events: 2,
      savedUsd: 2,
      basis: "estimated-baseline",
    });
    // A purely measured line carries no basis field at all.
    const measuredOnly = recomputeInvoice([events[1]!]);
    expect("basis" in measuredOnly.lineItems[0]!).toBe(false);
  });
});

describe("carry-forward netting (G.5 mechanic)", () => {
  const paidEvent = (requestId: string, savedUsd: number): BillableEvent => ({
    schemaVersion: 1,
    requestId,
    applicationId: "app",
    invoicePeriod: "2026-10",
    timestamp: "2026-10-20T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
    status: "succeeded",
  });

  it("offsets the fee by the carried deficit and reports the applied amount", () => {
    const invoice = recomputeInvoice([paidEvent("a", 500)], { feePercent: 1, carryForwardDeficitUsd: 200 });
    expect(invoice.carryForwardDeficitInUsd).toBe(200);
    expect(invoice.carryForwardDeficitOutUsd).toBeUndefined();
    expect(invoice.verdict).toBe("charge");
    expect(invoice.amountDueUsd).toBeCloseTo(3, 10); // 1% of (500 - 200)
    expect(invoice.amountDueCents).toBe(300);
  });

  it("a carried deficit that leaves a positive remainder too small to bill is do_not_charge, with no new deficit", () => {
    // 0.5 - 0.2 = $0.30 left; 1% of that is 0.3 of a cent.
    const invoice = recomputeInvoice([paidEvent("a", 0.5)], { feePercent: 1, carryForwardDeficitUsd: 0.2 });
    expect(invoice.carryForwardDeficitInUsd).toBe(0.2);
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.amountDueUsd).toBe(0);
    // The remainder is positive, so it is not a deficit and nothing rolls forward.
    expect(invoice.carryForwardDeficitOutUsd).toBeUndefined();
    expect("carryForwardDeficitOutUsd" in invoice).toBe(false);
  });

  it("carries the remaining deficit forward when it exceeds the period's savings", () => {
    const invoice = recomputeInvoice([paidEvent("a", 0.1)], { feePercent: 1, carryForwardDeficitUsd: 0.5 });
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.amountDueUsd).toBe(0);
    expect(invoice.carryForwardDeficitOutUsd).toBeCloseTo(0.4, 10);
  });

  it("a negative period emits a deficit even without the option", () => {
    const invoice = recomputeInvoice([paidEvent("a", -0.3)], { feePercent: 1 });
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.carryForwardDeficitOutUsd).toBeCloseTo(0.3, 10);
  });

  it("rejects a negative carry", () => {
    expect(() => recomputeInvoice([paidEvent("a", 0.1)], { carryForwardDeficitUsd: -1 })).toThrow();
  });
});

describe("the fee rounds down to the cent, and the verdict agrees with the fee", () => {
  const saved = (requestId: string, savedUsd: number): BillableEvent => ({
    schemaVersion: 1,
    requestId,
    applicationId: "app",
    invoicePeriod: "2026-11",
    timestamp: "2026-11-10T10:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
    status: "succeeded",
  });
  const at1 = (netUsd: number) => recomputeInvoice([saved("a", netUsd)], { feePercent: 1 });

  it("net $0.3609 at 1%: the fee is 0.36 of a cent, so do_not_charge, 0 cents, nothing carried", () => {
    const invoice = at1(0.3609);
    expect(invoice.netVerifiedSavingsUsd).toBe(0.3609);
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.amountDueUsd).toBe(0);
    expect(invoice.carryForwardDeficitOutUsd).toBeUndefined();
    // The savings figure itself is untouched and still rounds to the nearest cent.
    expect(invoice.netVerifiedSavingsCents).toBe(36);
  });

  it("net $0.99 at 1% is 0 cents and do_not_charge; net $1.00 is 1 cent and charge", () => {
    const under = at1(0.99);
    expect(under.amountDueCents).toBe(0);
    expect(under.verdict).toBe("do_not_charge");
    expect(under.carryForwardDeficitOutUsd).toBeUndefined();

    const exact = at1(1);
    expect(exact.amountDueCents).toBe(1);
    expect(exact.verdict).toBe("charge");
    expect(exact.amountDueUsd).toBeCloseTo(0.01, 12);
  });

  it("rounds down, never to the nearest cent: $21.63 is 21 cents, $9.5947 is 9 cents, $0.50 is 0 cents", () => {
    // Nearest-cent rounding made these 22 cents (1.017%) and 10 cents (1.04%).
    const a = at1(21.63);
    expect(a.amountDueCents).toBe(21);
    expect(a.verdict).toBe("charge");
    // amountDueUsd is the fee before rounding; the billed figure is amountDueCents.
    expect(a.amountDueUsd).toBeCloseTo(0.2163, 12);

    const b = at1(9.5947);
    expect(b.amountDueCents).toBe(9);
    expect(b.verdict).toBe("charge");

    expect(at1(21.6267).amountDueCents).toBe(21);

    // Half a cent of fee used to round up to a 1 cent charge.
    const half = at1(0.5);
    expect(half.amountDueCents).toBe(0);
    expect(half.verdict).toBe("do_not_charge");
    expect(at1(0.49).verdict).toBe("do_not_charge");
    expect(at1(1.99).amountDueCents).toBe(1);
  });

  it("the fee is never more than the contracted percentage of net savings", () => {
    for (const net of [1, 1.5, 9.5947, 21.63, 21.6267, 99.99, 149.995, 1234.5678]) {
      for (const feePercent of [1, 2.5, 10, 15]) {
        const invoice = recomputeInvoice([saved("a", net)], { feePercent });
        expect(invoice.amountDueCents! / 100).toBeLessThanOrEqual((net * feePercent) / 100 + 1e-9);
        // ...and less than one cent below it.
        expect((net * feePercent) / 100 - invoice.amountDueCents! / 100).toBeLessThan(0.01);
      }
    }
  });

  it("whole-dollar savings from $1 to $500 at 1% owe exactly that many cents (no cent lost to binary floats)", () => {
    for (let dollars = 1; dollars <= 500; dollars += 1) {
      const invoice = at1(dollars);
      expect(invoice.amountDueCents, `$${dollars}.00`).toBe(dollars);
      expect(feeCents(dollars, 1), `$${dollars}.00`).toBe(dollars);
    }
    expect(at1(29).amountDueCents).toBe(29);
    expect(at1(100).amountDueCents).toBe(100);
  });

  it("a fee that is exactly a whole number of cents is not floored to one less", () => {
    // 0.29 * 100 is 28.999999999999996 in binary: a fee of exactly $0.29 is 29 cents.
    expect(0.29 * 100).toBeLessThan(29);
    expect(feeCents(0.29, 100)).toBe(29);
    expect(recomputeInvoice([saved("a", 0.29)], { feePercent: 100 }).amountDueCents).toBe(29);
    expect(feeCents(2.9, 10)).toBe(29);
    expect(feeCents(29, 1)).toBe(29);
    // Every whole-cent fee from 1 cent to $50.00, reached three ways.
    for (let cents = 1; cents <= 5000; cents += 1) {
      expect(feeCents(cents / 100, 100), `${cents} at 100%`).toBe(cents);
      expect(feeCents(cents / 10, 10), `${cents} at 10%`).toBe(cents);
      expect(feeCents(cents, 1), `${cents} at 1%`).toBe(cents);
    }
    // Savings summed from many small levers (0.1 added 1,000 times is not exactly 100).
    const many = Array.from({ length: 1000 }, (_, i) => saved(`r${i}`, 0.1));
    const summed = recomputeInvoice(many, { feePercent: 1 });
    expect(summed.netVerifiedSavingsUsd).not.toBe(100);
    expect(summed.amountDueCents).toBe(100);
  });

  it("the tolerance does not round a genuinely smaller fee up", () => {
    expect(feeCents(0.9999, 1)).toBe(0);
    expect(feeCents(99.999, 1)).toBe(99);
    expect(feeCents(28.9999, 1)).toBe(28);
  });

  it("zero, negative and non-finite inputs owe nothing", () => {
    expect(feeCents(0, 1)).toBe(0);
    expect(feeCents(-5, 1)).toBe(0);
    expect(feeCents(100, 0)).toBe(0);
    expect(feeCents(Number.NaN, 1)).toBe(0);
    expect(feeCents(Number.POSITIVE_INFINITY, 1)).toBe(0);
  });

  it("a zero fee rate is do_not_charge: the verdict is charge only when cents are owed", () => {
    const invoice = recomputeInvoice([saved("a", 50)], { feePercent: 0 });
    expect(invoice.amountDueCents).toBe(0);
    expect(invoice.verdict).toBe("do_not_charge");
  });

  it("without a feePercent the verdict is unchanged: it only says whether net savings are positive", () => {
    const small = recomputeInvoice([saved("a", 0.3609)]);
    expect(small.verdict).toBe("charge");
    expect(small.feePercent).toBeUndefined();
    expect(small.amountDueCents).toBeUndefined();
    expect(small.amountDueUsd).toBeUndefined();
    // Below half a cent of savings still rounds to zero cents of savings.
    expect(recomputeInvoice([saved("a", 0.0024)]).verdict).toBe("do_not_charge");
    expect(recomputeInvoice([saved("a", 0.005)]).verdict).toBe("charge");
    expect(recomputeInvoice([saved("a", -1)]).verdict).toBe("do_not_charge");
  });

  it("stays deterministic with a fee: shuffled or replayed events give a byte-identical invoice", () => {
    const events = [saved("a", 0.2), saved("b", 0.1609), saved("c", 9.2338)];
    const once = JSON.stringify(recomputeInvoice(events, { feePercent: 1 }));
    const again = JSON.stringify(recomputeInvoice([events[2]!, events[0]!, events[1]!, ...events], { feePercent: 1 }));
    expect(again).toBe(once);
  });
});
