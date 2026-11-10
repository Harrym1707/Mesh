// Scout agent — continuously discovers techniques that could reduce token
// usage and records each as a structured Optimisation Lead. A Scout writes no
// production code; it only creates leads.
//
// Research effort is allocated 50% core / 30% adjacent / 20% exploratory, and
// within that envelope biased by what has worked: a category with promoted
// wins is favoured, one with repeated failures is damped (the lab learns where
// to look). Leads already in the ledger are skipped (duplicate awareness).

import { CATALOG, type CatalogEntry } from "../catalog.js";
import { fingerprint, type LabLedger } from "../ledger.js";
import type { OptimisationCategory, OptimisationLead, ResearchBucket } from "../types.js";

export type ScoutResult = {
  created: string[];
  skipped: { techniqueKey: string; reason: string }[];
  /** Whether any of the created leads were generated (not from the catalogue). */
  generated: number;
};

// When the seed catalogue is exhausted, the Scout keeps finding real work by
// sweeping parameters of the promoted/runnable levers — a bounded hypothesis
// search for a better operating point. Every variant is content-blind, runnable
// and measurable, so continuous scouting produces genuine experiments rather
// than idle spin. Once the grid is explored (and settled in the ledger), the
// Scout has nothing new and the loop goes idle honestly.
const VARIANT_GRID: {
  techniqueId: string;
  category: OptimisationCategory;
  bucket: ResearchBucket;
  fixture: string;
  param: string;
  values: number[];
}[] = [
  {
    techniqueId: "dedupe-repeated-blocks",
    category: "deduplication",
    bucket: "core",
    fixture: "rag-duplicate-passages",
    param: "minimumBlockTokens",
    values: [12, 16, 32, 40],
  },
  {
    techniqueId: "dedupe-then-collapse",
    category: "compaction",
    bucket: "adjacent",
    fixture: "rag-duplicate-passages",
    param: "minimumBlockTokens",
    values: [12, 32],
  },
];

function derivedLeads(): CatalogEntry[] {
  const leads: CatalogEntry[] = [];
  for (const grid of VARIANT_GRID) {
    for (const value of grid.values) {
      leads.push({
        title: `${grid.techniqueId} @ ${grid.param}=${value} (scout-tuned variant)`,
        description: `Lab-generated parameter-sweep variant of ${grid.techniqueId} (${grid.param}=${value}), searching for a better lossless operating point than the default.`,
        category: grid.category,
        bucket: grid.bucket,
        techniqueKey: `${grid.techniqueId}@${grid.param}=${value}`,
        hypothesis: `A ${grid.param} of ${value} captures more lossless savings than the default on ${grid.fixture}.`,
        controlSurface: grid.category === "deduplication" ? "deduplication" : "context-compaction",
        featureInputs: ["structural-counts", "token-counts", "keyed-prefix-hash"],
        changesCustomerApplication: false,
        expectedTokenReductionPercent: 20,
        techniqueId: grid.techniqueId,
        defaultParams: { [grid.param]: value },
        datasetFixtureId: grid.fixture,
      });
    }
  }
  return leads;
}

const BUCKET_SHARE: Record<ResearchBucket, number> = {
  core: 0.5,
  adjacent: 0.3,
  exploratory: 0.2,
};

function priorityBoost(
  outcomes: ReturnType<LabLedger["categoryOutcomes"]>,
  category: string,
): number {
  const o = outcomes[category];
  if (!o) return 1;
  const boost = 1 + 0.5 * o.promoted - 0.25 * (o.failed + o.rejected);
  return Math.max(0.1, boost);
}

function quotas(count: number): Record<ResearchBucket, number> {
  const core = Math.round(count * BUCKET_SHARE.core);
  const adjacent = Math.round(count * BUCKET_SHARE.adjacent);
  const exploratory = Math.max(0, count - core - adjacent);
  return { core, adjacent, exploratory };
}

export function scoutDispatch(
  ledger: LabLedger,
  options: { count?: number; now?: () => string; generate?: boolean } = {},
): ScoutResult {
  const now = options.now ?? (() => new Date().toISOString());
  const count = options.count ?? CATALOG.length;
  const outcomes = ledger.categoryOutcomes();
  const perBucket = quotas(count);

  const created: string[] = [];
  const skipped: ScoutResult["skipped"] = [];
  const handled = new Set<string>();

  const score = (entry: CatalogEntry) =>
    entry.expectedTokenReductionPercent * priorityBoost(outcomes, entry.category);

  const tryCreate = (entry: CatalogEntry): boolean => {
    if (handled.has(entry.techniqueKey)) return false;
    const fp = fingerprint(entry.category, entry.techniqueKey);
    if (ledger.findByFingerprint(fp)) {
      skipped.push({ techniqueKey: entry.techniqueKey, reason: "already in ledger" });
      handled.add(entry.techniqueKey);
      return false;
    }
    const lead: OptimisationLead = {
      ...entry,
      source: {
        kind: "catalogue",
        reference: "docs/rnd/lever-backlog.md + docs/rnd/scout/*",
        discoveredBy: "scout",
        discoveredAt: now(),
      },
    };
    created.push(ledger.createLead("scout", lead).id);
    handled.add(entry.techniqueKey);
    return true;
  };

  const byBucket: Record<ResearchBucket, CatalogEntry[]> = { core: [], adjacent: [], exploratory: [] };
  for (const entry of CATALOG) byBucket[entry.bucket].push(entry);

  let budget = count;

  // Pass 1: honour the 50/30/20 split within the budget.
  for (const bucket of ["core", "adjacent", "exploratory"] as ResearchBucket[]) {
    const ranked = [...byBucket[bucket]].sort((a, b) => score(b) - score(a));
    let taken = 0;
    for (const entry of ranked) {
      if (budget <= 0 || taken >= perBucket[bucket]) break;
      if (tryCreate(entry)) {
        taken += 1;
        budget -= 1;
      }
    }
  }

  // Pass 2: spend any remaining budget across all buckets by rank, so a full
  // dispatch (the default) always discovers the whole catalogue in one pass
  // even when rounding leaves a bucket under-filled.
  if (budget > 0) {
    for (const entry of [...CATALOG].sort((a, b) => score(b) - score(a))) {
      if (budget <= 0) break;
      if (tryCreate(entry)) budget -= 1;
    }
  }

  // Pass 3 (continuous mode): the catalogue is drained, so generate fresh
  // parameter-sweep leads to keep scouting productive.
  let generated = 0;
  if (options.generate && created.length === 0 && budget > 0) {
    for (const entry of derivedLeads()) {
      if (budget <= 0) break;
      if (tryCreate(entry)) {
        budget -= 1;
        generated += 1;
      }
    }
  }

  return { created, skipped, generated };
}
