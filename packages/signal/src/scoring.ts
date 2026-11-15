/**
 * Scoring — turn one raw answer into the six visibility signals.
 *
 * Every function here is pure and deterministic: the same `AnswerSample` and
 * `BrandProfile` always produce the same `SignalMeasurement`. That is what
 * makes scoring testable with fixtures and what lets the aggregator treat
 * repeated runs as independent samples.
 */

import type {
  AnswerSample,
  BrandProfile,
  Citation,
  FactualDescriptionResult,
  SignalMeasurement,
  SourceOverlapResult,
} from "./schema.js";

/**
 * How close (in characters) a category keyword must sit to a brand mention to
 * count as the answer associating the brand with that category. Whole-text
 * co-occurrence over-counts — a keyword three paragraphs from the mention is
 * not an association — so association is measured by proximity instead.
 */
const CATEGORY_PROXIMITY_RADIUS = 220;

/** Normalise text for case-insensitive, punctuation-tolerant matching. */
function normalise(text: string): string {
  return text.toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `haystack` contain `needle` as a whole token (not as a substring of a
 * larger word)? Keeps "mesh" from matching "meshing" or "enmeshed".
 */
function containsTerm(haystack: string, needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (term === "") return false;
  // Word-ish boundaries: term must not be flanked by letters/digits. This lets
  // multi-word terms and terms with punctuation (e.g. "@harrym1707/sdk") match.
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`, "i").test(haystack);
}

/**
 * Character ranges of every whole-token occurrence of `needle` in `haystack`
 * (which must already be lowercased). Used for proximity checks.
 */
function termRanges(haystack: string, needle: string): Array<{ start: number; end: number }> {
  const term = needle.trim().toLowerCase();
  if (term === "") return [];
  const re = new RegExp(`(^|[^a-z0-9])(${escapeRegExp(term)})($|[^a-z0-9])`, "g");
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack)) !== null) {
    const start = match.index + match[1]!.length;
    const end = start + match[2]!.length;
    ranges.push({ start, end });
    // Resume just after the token so trailing-boundary overlap can't loop.
    re.lastIndex = end;
  }
  return ranges;
}

/** Gap in characters between two ranges; 0 if they touch or overlap. */
function rangeGap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, a.start - b.end, b.start - a.end);
}

/** All the names that count as naming the brand. */
function brandTerms(brand: BrandProfile): string[] {
  return [brand.name, ...(brand.aliases ?? [])].filter((t) => t.trim() !== "");
}

/** Extract a bare host from a URL or a value that is already a host. */
export function domainOf(value: string | undefined): string | undefined {
  const { host } = splitHostPath(value);
  return host;
}

/**
 * Split a URL / owned-source entry into a host and lowercased path segments.
 * Scheme, query and fragment are stripped; a leading "www." is dropped.
 */
function splitHostPath(value: string | undefined): { host?: string; path: string[] } {
  if (!value) return { path: [] };
  let s = value.trim();
  if (s === "") return { path: [] };
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  const slash = s.indexOf("/");
  const hostPart = slash === -1 ? s : s.slice(0, slash);
  let pathPart = slash === -1 ? "" : s.slice(slash);
  pathPart = pathPart.split(/[?#]/)[0] ?? pathPart;
  const host = hostPart.replace(/^www\./i, "").toLowerCase() || undefined;
  const path = pathPart
    .toLowerCase()
    .split("/")
    .filter((segment) => segment !== "");
  return { host, path };
}

type OwnedSource = { host: string; path: string[] };

/**
 * Parse the brand's owned-source entries. An entry may be a bare host
 * ("mesh-ai.dev", owns the whole domain) or a host plus a path prefix
 * ("github.com/harrym1707", owns only that path on a shared host). The path
 * prefix is what stops every github repo or npm package counting as ours.
 */
function ownedSources(brand: BrandProfile): OwnedSource[] {
  const sources: OwnedSource[] = [];
  for (const entry of brand.ownedDomains) {
    const { host, path } = splitHostPath(entry);
    if (host) sources.push({ host, path });
  }
  return sources;
}

/** Does `path` begin with every segment of `prefix`? */
function pathHasPrefix(prefix: string[], path: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, i) => path[i] === segment);
}

/** Resolve a citation's host and path, preferring its URL over a bare domain. */
function citationHostPath(citation: Citation): { host?: string; path: string[] } {
  return splitHostPath(citation.url ?? citation.domain);
}

/**
 * Is this citation to a source the brand owns? Host must match an owned source
 * AND, when that source carries a path prefix, the citation's path must begin
 * with it. A bare-host owned entry owns every path on that host.
 */
function isOwnedCitation(citation: Citation, owned: OwnedSource[]): boolean {
  const { host, path } = citationHostPath(citation);
  if (!host) return false;
  return owned.some((source) => source.host === host && pathHasPrefix(source.path, path));
}

/** Signal 1: brand named anywhere in the answer text. */
export function detectMention(sample: AnswerSample, brand: BrandProfile): boolean {
  const text = normalise(sample.text);
  return brandTerms(brand).some((term) => containsTerm(text, term));
}

/**
 * Signal 2: brand appears among the engine's cited sources — either a cited
 * source is owned (host + path aware), or a citation's title/url names the brand.
 */
export function detectCitation(sample: AnswerSample, brand: BrandProfile): boolean {
  const owned = ownedSources(brand);
  const terms = brandTerms(brand);
  return (sample.citations ?? []).some((citation) => {
    if (isOwnedCitation(citation, owned)) return true;
    const title = normalise(citation.title ?? "");
    const url = normalise(citation.url ?? "");
    return terms.some((term) => containsTerm(title, term) || containsTerm(url, term));
  });
}

/** Signal 3: a resolvable link (http/https URL) to an owned source. */
export function detectLink(sample: AnswerSample, brand: BrandProfile): boolean {
  const owned = ownedSources(brand);
  return (sample.citations ?? []).some((citation) => {
    if (!citation.url || !/^https?:\/\//i.test(citation.url.trim())) return false;
    return isOwnedCitation(citation, owned);
  });
}

/**
 * Signal 4: categories the answer associated the brand with. A category counts
 * when the brand is mentioned AND one of the category's keywords appears within
 * `CATEGORY_PROXIMITY_RADIUS` characters of a brand mention (not merely anywhere
 * in the answer).
 */
export function detectCategoryAssociations(
  sample: AnswerSample,
  brand: BrandProfile,
  mentioned: boolean,
): string[] {
  if (!mentioned) return [];
  const text = normalise(sample.text);
  const mentionRanges = brandTerms(brand).flatMap((term) => termRanges(text, term));
  if (mentionRanges.length === 0) return [];

  return brand.categories
    .filter((category) =>
      category.keywords.some((keyword) =>
        termRanges(text, keyword).some((keywordRange) =>
          mentionRanges.some((mentionRange) => rangeGap(mentionRange, keywordRange) <= CATEGORY_PROXIMITY_RADIUS),
        ),
      ),
    )
    .map((category) => category.id);
}

/**
 * Signal 5: how the answer describes the brand, checked against canonical
 * claims. A claim is supported if any of its `supportedBy` phrases is present
 * and none of its `contradictedBy` phrases is; it is contradicted if any
 * `contradictedBy` phrase is present. Only evaluated when the brand is named.
 */
export function scoreFactualDescription(
  sample: AnswerSample,
  brand: BrandProfile,
  mentioned: boolean,
): FactualDescriptionResult {
  const empty: FactualDescriptionResult = {
    present: false,
    correct: false,
    supportedClaims: [],
    contradictedClaims: [],
  };
  if (!mentioned) return empty;

  const text = normalise(sample.text);
  const supportedClaims: string[] = [];
  const contradictedClaims: string[] = [];

  for (const claim of brand.canonicalClaims) {
    const contradicted = (claim.contradictedBy ?? []).some((phrase) => containsTerm(text, phrase));
    const supported = claim.supportedBy.some((phrase) => containsTerm(text, phrase));
    if (contradicted) {
      contradictedClaims.push(claim.id);
    } else if (supported) {
      supportedClaims.push(claim.id);
    }
  }

  const present = supportedClaims.length > 0 || contradictedClaims.length > 0;
  const correct = present && supportedClaims.length > 0 && contradictedClaims.length === 0;
  return { present, correct, supportedClaims, contradictedClaims };
}

/**
 * Signal 6: overlap between cited sources and the brand's owned sources.
 * Sources are keyed by host for display/ranking, but ownership is decided per
 * citation (host + path aware), so a shared host is marked owned only when a
 * citation to it actually points at an owned path.
 */
export function scoreSourceOverlap(sample: AnswerSample, brand: BrandProfile): SourceOverlapResult {
  const owned = ownedSources(brand);
  const citedDomains: string[] = [];
  const seen = new Set<string>();
  const ownedHosts = new Set<string>();

  for (const citation of sample.citations ?? []) {
    const { host } = citationHostPath(citation);
    if (!host) continue;
    if (!seen.has(host)) {
      seen.add(host);
      citedDomains.push(host);
    }
    if (isOwnedCitation(citation, owned)) ownedHosts.add(host);
  }

  const ownedDomainsCited = citedDomains.filter((host) => ownedHosts.has(host));
  const overlapRatio = citedDomains.length === 0 ? null : ownedDomainsCited.length / citedDomains.length;
  return { citedDomains, ownedDomainsCited, overlapRatio };
}

/** Competing brands that appear in the answer text. */
export function detectCompetitors(sample: AnswerSample, brand: BrandProfile): string[] {
  const text = normalise(sample.text);
  return (brand.competitors ?? []).filter((name) => containsTerm(text, name));
}

/**
 * Score one raw answer into a full `SignalMeasurement`. Pure: no clock, no I/O.
 * The runner supplies `runId` and a timestamp; a failed sample (one carrying an
 * `error`) scores as all-negative so a flaky engine lowers rates rather than
 * crashing the batch.
 */
export function scoreAnswer(
  sample: AnswerSample,
  brand: BrandProfile,
  context: { runId: string; timestamp: string },
): SignalMeasurement {
  const queryId = sample.queryId ?? sample.query;
  const categoriesProbed = sample.categories ?? [];

  if (sample.error !== undefined) {
    return {
      engine: sample.engine,
      query: sample.query,
      queryId,
      runId: context.runId,
      timestamp: sample.timestamp ?? context.timestamp,
      mentioned: false,
      cited: false,
      linked: false,
      categoriesAssociated: [],
      factualDescription: { present: false, correct: false, supportedClaims: [], contradictedClaims: [] },
      sourceOverlap: { citedDomains: [], ownedDomainsCited: [], overlapRatio: null },
      categoriesProbed,
      competitorMentions: [],
      error: sample.error,
    };
  }

  const mentioned = detectMention(sample, brand);
  return {
    engine: sample.engine,
    query: sample.query,
    queryId,
    runId: context.runId,
    timestamp: sample.timestamp ?? context.timestamp,
    mentioned,
    cited: detectCitation(sample, brand),
    linked: detectLink(sample, brand),
    categoriesAssociated: detectCategoryAssociations(sample, brand, mentioned),
    factualDescription: scoreFactualDescription(sample, brand, mentioned),
    sourceOverlap: scoreSourceOverlap(sample, brand),
    categoriesProbed,
    competitorMentions: detectCompetitors(sample, brand),
  };
}
