/**
 * MESH Signal — result schema for AI-visibility measurement.
 *
 * Stage 12 of the build roadmap. MESH Signal measures how a brand (MESH) is
 * represented across AI search / answer engines. Because AI answers vary
 * between runs, a single measurement is never trusted on its own: the runner
 * takes repeated measurements and the aggregator reports rates and
 * distributions over N runs.
 *
 * This module defines only the data shapes. Scoring lives in `scoring.ts`,
 * the measurement loop in `runner.ts`, and aggregation in `aggregate.ts`.
 */

/** The six visibility signals Stage 12 tracks for a brand. */
export type SignalKind =
  | "mention"
  | "citation"
  | "link"
  | "category_association"
  | "factual_description"
  | "source_overlap";

export const SIGNAL_KINDS: readonly SignalKind[] = [
  "mention",
  "citation",
  "link",
  "category_association",
  "factual_description",
  "source_overlap",
] as const;

/** A category the brand wants to be associated with, plus the terms that mark it. */
export type CategoryDefinition = {
  /** Stable id, e.g. "llm-routing". */
  id: string;
  /** Human label, e.g. "LLM routing". */
  label: string;
  /** Lowercased terms whose presence near a brand mention counts as association. */
  keywords: string[];
};

/**
 * A canonical, checkable claim about the brand. Used to decide whether an
 * engine's description of the brand is factually correct.
 */
export type CanonicalClaim = {
  /** Stable id, e.g. "category". */
  id: string;
  /** Phrases that, if present, support this claim (any one matches). */
  supportedBy: string[];
  /** Phrases that, if present, contradict this claim (any one matches). */
  contradictedBy?: string[];
};

/**
 * Stable, injectable description of the brand being measured. Nothing here is
 * MESH-specific in the code — callers supply MESH's profile (or any brand's),
 * which keeps the package reusable and the tests honest.
 */
export type BrandProfile = {
  /** Primary brand name, e.g. "MESH". */
  name: string;
  /** Alternate names/spellings that also count as a mention. */
  aliases?: string[];
  /** Domains the brand owns or controls (its "authority" sources). */
  ownedDomains: string[];
  /** Categories the brand wants to be associated with. */
  categories: CategoryDefinition[];
  /** Checkable claims used to score factual-description correctness. */
  canonicalClaims: CanonicalClaim[];
  /** Competing brand names to track when they co-occur with ours. */
  competitors?: string[];
};

/** One source the engine attributed its answer to. */
export type Citation = {
  /** Full URL if the engine linked the source. */
  url?: string;
  /** Domain of the source; derived from `url` when omitted. */
  domain?: string;
  /** Display title / publisher of the source, if any. */
  title?: string;
};

/**
 * The raw output of one (engine, query) run, as returned by a measurement
 * backend. This is the injection boundary: a live backend fills it from a real
 * engine, tests fill it from fixtures. Scoring only ever reads this shape.
 */
export type AnswerSample = {
  /** The engine/surface queried, e.g. "chatgpt", "perplexity". */
  engine: string;
  /** The query text sent to the engine. */
  query: string;
  /** Stable id for the query (so repeated runs line up). */
  queryId?: string;
  /** Category ids this query is intended to probe. */
  categories?: string[];
  /** The engine's answer text. */
  text: string;
  /** Sources the engine cited. */
  citations?: Citation[];
  /** When the answer was produced (ISO 8601); defaults applied by the runner. */
  timestamp?: string;
  /** Set when the backend failed to produce an answer for this query. */
  error?: string;
};

/** How the brand's factual description scored in one answer. */
export type FactualDescriptionResult = {
  /** The answer described the brand at all (at least one claim touched). */
  present: boolean;
  /** Described correctly: at least one supported claim and no contradicted claim. */
  correct: boolean;
  /** Ids of canonical claims the answer supported. */
  supportedClaims: string[];
  /** Ids of canonical claims the answer contradicted. */
  contradictedClaims: string[];
};

/** Overlap between the engine's cited sources and the brand's owned sources. */
export type SourceOverlapResult = {
  /** Unique domains the engine cited. */
  citedDomains: string[];
  /** Cited domains that the brand owns. */
  ownedDomainsCited: string[];
  /** ownedDomainsCited / citedDomains, or null when nothing was cited. */
  overlapRatio: number | null;
};

/**
 * The scored result for a single (engine, query) run — one answer turned into
 * the six signals. Individual measurements are stored; rates and distributions
 * are only ever computed by aggregating many of them.
 */
export type SignalMeasurement = {
  engine: string;
  query: string;
  queryId: string;
  /** Id of the run this measurement belongs to. */
  runId: string;
  timestamp: string;

  /** Signal 1: the brand was named in the answer text. */
  mentioned: boolean;
  /** Signal 2: the brand appears among the engine's cited sources. */
  cited: boolean;
  /** Signal 3: the answer contains a resolvable link to an owned domain. */
  linked: boolean;
  /** Signal 4: category ids the answer associated the brand with. */
  categoriesAssociated: string[];
  /** Signal 5: how the brand's factual description scored. */
  factualDescription: FactualDescriptionResult;
  /** Signal 6: overlap of cited sources with owned sources. */
  sourceOverlap: SourceOverlapResult;

  /** Category ids this query was intended to probe (echoed for aggregation). */
  categoriesProbed: string[];
  /** Competing brands that co-occurred in the answer. */
  competitorMentions: string[];
  /** Set when the backend reported an error for this query. */
  error?: string;
};

/** One full pass over the prompt set: the atomic unit of repetition. */
export type MeasurementRun = {
  runId: string;
  timestamp: string;
  measurements: SignalMeasurement[];
};
