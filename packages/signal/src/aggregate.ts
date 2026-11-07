/**
 * Aggregation — turn many measurement runs into rates and distributions.
 *
 * This is the core of Stage 12's "never single-shot" rule. AI answers vary
 * between runs, so a rate from one run is noise. The aggregator pools all
 * measurements for headline rates AND reports the per-run distribution
 * (mean / stddev / min / max over runs) so callers can see how stable each
 * signal is.
 *
 * Denominators (documented because they differ by signal, per the GEO spec):
 *   - mentionRate            = mentions / measurements
 *   - citationRate           = citations / mentions        (conditional on mention)
 *   - linkRate               = links / mentions            (conditional on mention)
 *   - descriptionPresentRate = descriptionsPresent / mentions
 *   - correctDescriptionRate = correctDescriptions / descriptionsPresent
 * A null rate means the denominator was zero (not enough signal to divide).
 *
 * The conditional rates (citation/link) count ONLY measurements that are also
 * mention-positive, so the numerator is always a subset of the denominator and
 * the rate stays in [0, 1]. A citation or link in a measurement where the brand
 * was not mentioned does not count toward citationRate/linkRate — "of the
 * answers that mentioned us, how many also cited/linked us?".
 */

import type { MeasurementRun, SignalMeasurement } from "./schema.js";

/** Headline rates over a set of measurements, with their raw counts. */
export type SignalRates = {
  measurements: number;
  mentions: number;
  mentionRate: number | null;
  /** Measurements that both mentioned AND cited the brand (numerator of citationRate). */
  citations: number;
  citationRate: number | null;
  /** Measurements that both mentioned AND linked the brand (numerator of linkRate). */
  links: number;
  linkRate: number | null;
  descriptionsPresent: number;
  descriptionPresentRate: number | null;
  correctDescriptions: number;
  correctDescriptionRate: number | null;
  /** Mean source-overlap ratio over measurements that cited anything. */
  meanSourceOverlap: number | null;
};

/** Distribution of a per-run rate across runs. */
export type Distribution = {
  /** Number of runs that contributed a defined value. */
  runs: number;
  mean: number | null;
  /** Population standard deviation across runs. */
  stddev: number | null;
  min: number | null;
  max: number | null;
  /** The per-run values, in run order (null where the denominator was zero). */
  values: (number | null)[];
};

/** Per-category association, pooled across all runs. */
export type CategoryAssociation = {
  categoryId: string;
  /** Measurements whose query probed this category. */
  probed: number;
  /** Of those, how many associated the brand with the category. */
  associated: number;
  /** associated / probed, or null when the category was never probed. */
  associationRate: number | null;
};

/** A cited source domain and how often it appeared. */
export type SourceCount = {
  domain: string;
  count: number;
  owned: boolean;
};

/** The full MESH Signal report over N runs. */
export type SignalReport = {
  runs: number;
  measurements: number;
  /** Pooled rates over every measurement in every run. */
  overall: SignalRates;
  /** Per-run rates, in run order. */
  perRun: SignalRates[];
  /** Distribution of each headline rate across runs. */
  distribution: {
    mentionRate: Distribution;
    citationRate: Distribution;
    linkRate: Distribution;
    correctDescriptionRate: Distribution;
  };
  /** Rates split by engine (pooled across runs). */
  byEngine: Record<string, SignalRates>;
  /** Category-association rates (pooled across runs). */
  byCategory: CategoryAssociation[];
  /** Cited source domains, most frequent first. */
  topSources: SourceCount[];
  /** Competitor brand -> number of measurements it co-occurred in. */
  competitorMentions: Record<string, number>;
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Pool a flat list of measurements into headline rates. */
export function rateMeasurements(measurements: SignalMeasurement[]): SignalRates {
  const total = measurements.length;
  let mentions = 0;
  let citations = 0;
  let links = 0;
  let descriptionsPresent = 0;
  let correctDescriptions = 0;
  let overlapSum = 0;
  let overlapCount = 0;

  for (const m of measurements) {
    if (m.mentioned) {
      mentions++;
      // Conditional signals: only counted when the brand was also mentioned, so
      // the numerator can never exceed `mentions` and the rate stays <= 1.
      if (m.cited) citations++;
      if (m.linked) links++;
    }
    // present/correct are already mention-gated by scoreFactualDescription.
    if (m.factualDescription.present) descriptionsPresent++;
    if (m.factualDescription.correct) correctDescriptions++;
    if (m.sourceOverlap.overlapRatio !== null) {
      overlapSum += m.sourceOverlap.overlapRatio;
      overlapCount++;
    }
  }

  return {
    measurements: total,
    mentions,
    mentionRate: ratio(mentions, total),
    citations,
    citationRate: ratio(citations, mentions),
    links,
    linkRate: ratio(links, mentions),
    descriptionsPresent,
    descriptionPresentRate: ratio(descriptionsPresent, mentions),
    correctDescriptions,
    correctDescriptionRate: ratio(correctDescriptions, descriptionsPresent),
    meanSourceOverlap: ratio(overlapSum, overlapCount),
  };
}

/** Distribution of one per-run rate (nulls are dropped from the stats). */
function distribution(perRun: SignalRates[], pick: (r: SignalRates) => number | null): Distribution {
  const values = perRun.map(pick);
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) {
    return { runs: 0, mean: null, stddev: null, min: null, max: null, values };
  }
  const mean = defined.reduce((sum, v) => sum + v, 0) / defined.length;
  const variance = defined.reduce((sum, v) => sum + (v - mean) ** 2, 0) / defined.length;
  return {
    runs: defined.length,
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...defined),
    max: Math.max(...defined),
    values,
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k) ?? [];
    group.push(item);
    groups.set(k, group);
  }
  return groups;
}

function aggregateByEngine(all: SignalMeasurement[]): Record<string, SignalRates> {
  const groups = groupBy(all, (m) => m.engine);
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([engine, group]) => [engine, rateMeasurements(group)]),
  );
}

function aggregateByCategory(all: SignalMeasurement[]): CategoryAssociation[] {
  const probed = new Map<string, number>();
  const associated = new Map<string, number>();
  for (const m of all) {
    for (const categoryId of m.categoriesProbed) {
      probed.set(categoryId, (probed.get(categoryId) ?? 0) + 1);
    }
    for (const categoryId of m.categoriesAssociated) {
      associated.set(categoryId, (associated.get(categoryId) ?? 0) + 1);
    }
  }
  // A category can be associated even if it was never explicitly probed, so the
  // key set is the union of both maps.
  const categoryIds = new Set<string>([...probed.keys(), ...associated.keys()]);
  return [...categoryIds]
    .sort((a, b) => a.localeCompare(b))
    .map((categoryId) => {
      const probedCount = probed.get(categoryId) ?? 0;
      const associatedCount = associated.get(categoryId) ?? 0;
      return {
        categoryId,
        probed: probedCount,
        associated: associatedCount,
        associationRate: ratio(associatedCount, probedCount),
      };
    });
}

function aggregateSources(all: SignalMeasurement[]): SourceCount[] {
  const counts = new Map<string, number>();
  const owned = new Map<string, boolean>();
  for (const m of all) {
    const ownedSet = new Set(m.sourceOverlap.ownedDomainsCited);
    for (const domain of m.sourceOverlap.citedDomains) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
      owned.set(domain, (owned.get(domain) ?? false) || ownedSet.has(domain));
    }
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count, owned: owned.get(domain) ?? false }))
    // Most frequent first; ties broken alphabetically for a stable order.
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function aggregateCompetitors(all: SignalMeasurement[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const m of all) {
    for (const name of m.competitorMentions) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Aggregate repeated measurement runs into a single report. This is the only
 * sanctioned way to read a rate out of MESH Signal: it refuses to treat one
 * run as an answer and always exposes the across-run distribution alongside
 * the pooled headline figure.
 */
export function aggregateRuns(runs: MeasurementRun[]): SignalReport {
  const perRun = runs.map((run) => rateMeasurements(run.measurements));
  const all = runs.flatMap((run) => run.measurements);

  return {
    runs: runs.length,
    measurements: all.length,
    overall: rateMeasurements(all),
    perRun,
    distribution: {
      mentionRate: distribution(perRun, (r) => r.mentionRate),
      citationRate: distribution(perRun, (r) => r.citationRate),
      linkRate: distribution(perRun, (r) => r.linkRate),
      correctDescriptionRate: distribution(perRun, (r) => r.correctDescriptionRate),
    },
    byEngine: aggregateByEngine(all),
    byCategory: aggregateByCategory(all),
    topSources: aggregateSources(all),
    competitorMentions: aggregateCompetitors(all),
  };
}
