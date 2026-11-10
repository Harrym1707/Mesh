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
import type { OptimisationLead, ResearchBucket } from "../types.js";

export type ScoutResult = {
  created: string[];
  skipped: { techniqueKey: string; reason: string }[];
};

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
  options: { count?: number; now?: () => string } = {},
): ScoutResult {
  const now = options.now ?? (() => new Date().toISOString());
  const count = options.count ?? CATALOG.length;
  const outcomes = ledger.categoryOutcomes();
  const perBucket = quotas(count);

  const created: string[] = [];
  const skipped: ScoutResult["skipped"] = [];

  const byBucket: Record<ResearchBucket, CatalogEntry[]> = {
    core: [],
    adjacent: [],
    exploratory: [],
  };
  for (const entry of CATALOG) byBucket[entry.bucket].push(entry);

  for (const bucket of ["core", "adjacent", "exploratory"] as ResearchBucket[]) {
    const ranked = [...byBucket[bucket]].sort(
      (a, b) =>
        b.expectedTokenReductionPercent * priorityBoost(outcomes, b.category) -
        a.expectedTokenReductionPercent * priorityBoost(outcomes, a.category),
    );
    let taken = 0;
    for (const entry of ranked) {
      if (taken >= perBucket[bucket]) break;
      const fp = fingerprint(entry.category, entry.techniqueKey);
      if (ledger.findByFingerprint(fp)) {
        skipped.push({ techniqueKey: entry.techniqueKey, reason: "already in ledger" });
        continue;
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
      const record = ledger.createLead("scout", lead);
      created.push(record.id);
      taken += 1;
    }
  }

  return { created, skipped };
}
