// Mesh go-to-market engine: the records it keeps, and their schemas.
//
// The engine is the Lab's sibling (see lab/README.md): typed records, a
// permission table per agent, a hash-chained event log, an orchestrator and a
// CLI. Where the Lab keeps one record per optimisation, this keeps one record
// per commercial fact: a segment, a competitor, a search question, a visibility
// test, a prospect, a draft, an approval.
//
// Every record has an id, timestamps, the actor that wrote it, its sources
// (where the fact was read, and on what day) and a status. The kind-specific
// fields live under `data` and are validated at runtime on every write.

import { arr, bool, either, isoDate, isoInstant, num, obj, oneOf, opt, str, type Infer, type Schema } from "./schema.js";

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export const AGENTS = [
  "market-intelligence",
  "geo-seo",
  "content",
  "outbound",
  "partnerships",
  "conversion",
  "community",
  "growth-director",
] as const;

export type AgentName = (typeof AGENTS)[number];

/**
 * Who wrote something. An agent, one of the two pieces of engine machinery, or
 * a named human. A human actor is only ever constructed by the commands a
 * person runs (approve, record, suppress, budget set, add --as-human).
 */
export type Actor = AgentName | "orchestrator" | "importer" | `human:${string}`;

export function isAgent(actor: string): actor is AgentName {
  return (AGENTS as readonly string[]).includes(actor);
}

export function isHuman(actor: string): actor is `human:${string}` {
  return actor.startsWith("human:") && actor.length > "human:".length;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Where a fact was read. `url` is a public page, or a pointer into this
 * project: `repo:<path>[@ref]` (the product repository), `brain:<path>` (the
 * knowledge base), `store:<record id>` (derived from stored records) or
 * `human:<name>` (a person reported it).
 */
export const sourceSchema = obj({
  url: str({ pattern: /^(https?:\/\/\S+|(repo|brain|store|human):\S.*)$/, hint: "an http(s) URL, or repo:<path>, brain:<path>, store:<id>, human:<name>" }),
  readOn: isoDate,
  note: opt(str()),
});
export type Source = Infer<typeof sourceSchema>;

/** A value an agent could not confirm is written as "unknown", never guessed. */
const tri = either(bool, oneOf(["unknown"] as const));
const text = str();
const longText = str({ max: 20000 });
const ids = arr(str({ pattern: /^[A-Z]{3}-\d{4,}$/, hint: "a record id such as PRO-0001" }));

/**
 * A figure that appears in a draft. Every percentage or money amount in a
 * draft's text must be declared here, or the write is refused (see claims.ts).
 *   mesh-savings: a Mesh savings figure. It must be in docs/NUMBERS.md under
 *     its LIVE or SIMULATOR label, with its date and whether it is measured out
 *     of the box or with named levers switched on.
 *   mesh-fact: another Mesh figure (the fee, a version), with where it is stated.
 *   third-party: someone else's published figure, with the page and day read.
 */
export const figureSchema = obj({
  figure: text,
  kind: oneOf(["mesh-savings", "mesh-fact", "third-party"] as const),
  source: text,
  label: opt(oneOf(["LIVE", "SIMULATOR"] as const)),
  date: opt(isoDate),
  basis: opt(oneOf(["out-of-the-box", "levers-on"] as const)),
  levers: opt(arr(text)),
  readOn: opt(isoDate),
});
export type DeclaredFigure = Infer<typeof figureSchema>;

const draftSchema = obj({
  body: longText,
  figures: arr(figureSchema),
});

const period = obj({ start: isoDate, end: isoDate });

const experimentFields = {
  name: text,
  audience: text,
  problem: text,
  hypothesis: text,
  channel: text,
  budget: obj({ runs: opt(num({ min: 0, int: true })), costUsd: opt(num({ min: 0 })), note: opt(text) }),
  objective: text,
  period,
  evaluationMethod: text,
  result: opt(
    obj({
      summary: text,
      outcome: oneOf(["supported", "not-supported", "inconclusive"] as const),
      /** The stored metric observations the result rests on. Empty only when inconclusive. */
      observationIds: ids,
    }),
  ),
  decision: opt(obj({ choice: oneOf(["scale", "stop"] as const), reason: text })),
};

/** Role mailboxes only: a named person's address is personal data and is refused. */
export const ROLE_MAILBOXES = ["info", "hello", "contact", "sales", "support", "partnerships", "partners", "press", "team", "enquiries", "inquiries", "business"];

// ---------------------------------------------------------------------------
// Kind-specific data
// ---------------------------------------------------------------------------

const marketSegment = obj({
  name: text,
  description: text,
  problems: arr(text),
  whyNow: opt(text),
  size: opt(text),
});

const customerProfile = obj({
  name: text,
  segmentId: opt(text),
  description: text,
  /** A role, never a person ("engineering lead at an agent start-up"). */
  buyerRole: text,
  triggers: arr(text),
  disqualifiers: arr(text),
  channels: arr(text),
});

const competitor = obj({
  organisation: text,
  website: text,
  category: text,
  positioning: text,
  pricing: text,
  strengths: arr(text),
  weaknesses: arr(text),
  meshDifference: text,
  lastChecked: isoDate,
});

const buyingSignal = obj({
  organisation: text,
  prospectId: opt(text),
  signalType: oneOf(["cost-post", "pricing-change", "job-post", "repo-activity", "public-complaint", "other"] as const),
  summary: text,
  observedOn: isoDate,
  strength: oneOf(["low", "medium", "high", "unknown"] as const),
});

const opportunity = obj({
  title: text,
  type: oneOf(["segment", "content", "prospect", "partnership", "community", "conversion", "product"] as const),
  description: text,
  rationale: text,
  origin: oneOf(["market", "lab", "numbers", "geo", "human"] as const),
  relatedIds: ids,
  /** Set by the Lab link: the Lab record or docs/NUMBERS.md state this came from. */
  labRef: opt(text),
  /** False when the figures behind it are Lab SIMULATOR figures, which are never quoted externally. */
  quotable: opt(bool),
});

const searchQuery = obj({
  text,
  intent: oneOf(["informational", "comparative", "transactional", "navigational", "agent-task", "unclassified"] as const),
  audience: opt(text),
  priority: opt(num({ min: 1, max: 5, int: true })),
});

const visibilityTest = obj({
  queryId: opt(text),
  query: text,
  platform: text,
  date: isoDate,
  runNumber: num({ min: 1, int: true }),
  mentioned: tri,
  recommended: tri,
  cited: tri,
  position: opt(num({ min: 1, int: true })),
  competitorsMentioned: either(arr(text), oneOf(["unknown"] as const)),
  sourcesReferenced: either(arr(text), oneOf(["unknown"] as const)),
  descriptionAccuracy: oneOf(["accurate", "partly-accurate", "inaccurate", "not-described", "unknown"] as const),
  notes: opt(text),
});

const contentItem = obj({
  title: text,
  topic: text,
  format: oneOf(["page", "post", "comparison", "docs", "listing-copy", "other"] as const),
  targetQueryIds: ids,
  opportunityId: opt(text),
  researchNotes: opt(longText),
  brief: opt(obj({ audience: text, question: text, angle: text, mustInclude: arr(text), sourcesToUse: arr(text) })),
  draft: opt(draftSchema),
  /** Set by the store when the draft is handed to fact-check. Never accepted from an agent. */
  draftedBy: opt(text),
  /** `by` is set by the store to the acting agent. */
  factCheck: opt(obj({ by: opt(text), verdict: oneOf(["pass", "fail"] as const), checkedOn: isoDate, claimsChecked: num({ min: 0, int: true }), issues: arr(text) })),
  review: opt(obj({ by: opt(text), verdict: oneOf(["pass", "revise"] as const), notes: text })),
  publishedUrl: opt(text),
  distribution: opt(arr(obj({ channel: text, url: text }))),
  performance: opt(obj({ observationIds: ids })),
});

const contactRoute = obj({
  type: oneOf(["contact-page", "public-form", "github-org", "role-mailbox", "other-public-page"] as const),
  url: text,
  verified: tri,
  checkedOn: opt(isoDate),
});

const prospect = obj({
  organisation: text,
  website: text,
  organisationType: oneOf(["company", "open-source-project", "agency", "channel", "unknown"] as const),
  useCase: text,
  publicSignals: arr(obj({ summary: text, url: text, publishedOn: opt(text), readOn: isoDate })),
  spendSignal: opt(obj({ level: oneOf(["low", "low-medium", "medium", "medium-high", "high", "unknown"] as const), note: opt(text) })),
  qualification: opt(
    obj({
      score: num({ min: 0, max: 100, int: true }),
      reasons: arr(obj({ criterion: text, points: num({ int: true }), evidence: text }), { min: 1 }),
      scoredOn: isoDate,
    }),
  ),
  contactStatus: oneOf(["not-contacted", "draft-awaiting-approval", "contact-approved", "contacted", "replied", "do-not-contact"] as const),
  /** Organisations' own public business routes only. */
  contactRoutes: arr(contactRoute),
  collection: obj({ source: text, collectedOn: isoDate }),
  lawfulBasis: obj({
    basis: oneOf(["not-assessed", "legitimate-interests", "consent", "no-personal-data"] as const),
    note: text,
  }),
  optOut: bool,
  sourceStatus: oneOf(["verified", "unverified"] as const),
  angle: opt(text),
  notes: opt(text),
  segmentId: opt(text),
  opportunityId: opt(text),
  lostReason: opt(text),
});

const interaction = obj({
  subjectId: text,
  type: text,
  occurredOn: isoDate,
  evidence: str({ min: 8 }),
  reportedBy: text,
});

const outreachDraft = obj({
  prospectId: text,
  route: contactRoute,
  subject: text,
  body: longText,
  figures: arr(figureSchema),
});

const campaign = obj({ ...experimentFields });
const experiment = obj({ ...experimentFields, campaignId: opt(text) });

const partnership = obj({
  organisation: text,
  website: text,
  type: oneOf(["integration", "registry-listing", "directory", "co-marketing", "reseller", "other"] as const),
  rationale: text,
  requirements: opt(text),
  submissionRoute: opt(text),
  draft: opt(draftSchema),
});

const communityOpportunity = obj({
  venue: text,
  url: text,
  topic: text,
  type: oneOf(["question", "thread", "list", "event", "other"] as const),
  venueRules: opt(text),
  relevance: text,
  /** A reply is only ever drafted with the affiliation stated. */
  draft: opt(obj({ body: longText, figures: arr(figureSchema), disclosure: text })),
});

const metricObservation = obj({
  name: text,
  value: num(),
  unit: text,
  period,
  measuredBy: text,
  dimension: opt(text),
  note: opt(text),
});

const task = obj({
  agent: oneOf(AGENTS),
  taskKind: text,
  inputs: ids,
  instructions: opt(longText),
  priority: num({ min: 1, max: 5, int: true }),
  timeLimitMinutes: num({ min: 1, int: true }),
  costEstimateUsd: num({ min: 0 }),
  reason: text,
  attempts: num({ min: 0, int: true }),
  requeues: num({ min: 0, int: true }),
  claimedAt: opt(isoInstant),
  completedAt: opt(isoInstant),
  result: opt(obj({ summary: text, written: arr(text), unknowns: arr(text), followUps: arr(text) })),
  failureReason: opt(text),
});

const approval = obj({
  subjectId: text,
  relatedIds: ids,
  action: oneOf(["contact", "publish", "distribute", "post", "submit"] as const),
  approvedBy: text,
  approvedOn: isoDate,
  note: opt(text),
});

const budgetEntry = obj({
  taskId: text,
  agent: oneOf(AGENTS),
  startedAt: isoInstant,
  runs: num({ min: 1, max: 1, int: true }),
  costEstimateUsd: num({ min: 0 }),
  costBasis: text,
  closedAt: opt(isoInstant),
});

const marketRequest = obj({
  title: text,
  requestKind: oneOf(["evidence-request", "lever-request", "claim-check", "question"] as const),
  detail: text,
  motivationIds: ids,
  priority: num({ min: 1, max: 5, int: true }),
  answer: opt(text),
});

/**
 * Work that needs the built site changed or a release cut. The Command Center
 * chat owns docs/site/dist and every release; no agent rebuilds, tags or
 * publishes. A task whose outcome needs either ends in one of these.
 */
const releaseRequest = obj({
  title: text,
  addressedTo: oneOf(["command-center"] as const),
  what: text,
  recordIds: ids,
});

/**
 * One line of the backlog that steers a scheduled routine (today: the nightly
 * GEO routine, which measures search visibility and drafts at most one site
 * change a night). The GEO agent writes these; it does not re-run the searches.
 */
const routineBacklogItem = obj({
  routine: oneOf(["geo-nightly"] as const),
  action: oneOf(["measure", "draft"] as const),
  subject: text,
  reason: text,
  priority: num({ min: 1, max: 5, int: true }),
  queryIds: ids,
});

const suppression = obj({
  organisation: text,
  domain: opt(text),
  reason: text,
  requestedOn: isoDate,
  reportedBy: text,
});

// ---------------------------------------------------------------------------
// The kind table
// ---------------------------------------------------------------------------

export function orgKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(ltd|limited|inc|llc|gmbh|plc|corp|corporation|co|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i.exec(url.trim());
  return match?.[1]?.toLowerCase();
}

export function textKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

type KindDef<D> = {
  prefix: string;
  schema: Schema<D>;
  statuses: readonly string[];
  initial: string;
  /** Research records need at least one dated source; bookkeeping records need none. */
  minSources: number;
  /** Identity keys: a new record sharing any key with a stored one is that record. */
  keys?: (data: D) => string[];
  /** The words a topic search looks through. */
  words: (data: D) => string[];
};

function kind<D>(def: KindDef<D>): KindDef<D> {
  return def;
}

const org = (d: { organisation: string; website?: string }) =>
  [`org:${orgKey(d.organisation)}`, ...(domainOf(d.website) ? [`domain:${domainOf(d.website)}`] : [])];

export const KINDS = {
  "market-segment": kind({ prefix: "SEG", schema: marketSegment, statuses: ["draft", "validated", "retired"], initial: "draft", minSources: 1, keys: (d) => [`name:${textKey(d.name)}`], words: (d) => [d.name, d.description, ...d.problems] }),
  "customer-profile": kind({ prefix: "ICP", schema: customerProfile, statuses: ["draft", "validated", "retired"], initial: "draft", minSources: 1, keys: (d) => [`name:${textKey(d.name)}`], words: (d) => [d.name, d.description, d.buyerRole] }),
  competitor: kind({ prefix: "CMP", schema: competitor, statuses: ["tracked", "retired"], initial: "tracked", minSources: 1, keys: org, words: (d) => [d.organisation, d.category, d.positioning] }),
  "buying-signal": kind({ prefix: "SIG", schema: buyingSignal, statuses: ["new", "linked", "dismissed"], initial: "new", minSources: 1, keys: (d) => [`signal:${orgKey(d.organisation)}:${textKey(d.summary)}`], words: (d) => [d.organisation, d.summary] }),
  opportunity: kind({ prefix: "OPP", schema: opportunity, statuses: ["open", "in-progress", "converted", "dropped"], initial: "open", minSources: 1, keys: (d) => [`title:${textKey(d.title)}`, ...(d.labRef ? [`lab:${d.labRef}`] : [])], words: (d) => [d.title, d.description, d.rationale] }),
  "search-query": kind({ prefix: "QRY", schema: searchQuery, statuses: ["active", "retired"], initial: "active", minSources: 1, keys: (d) => [`query:${textKey(d.text)}`], words: (d) => [d.text, d.intent] }),
  "visibility-test": kind({ prefix: "VIS", schema: visibilityTest, statuses: ["recorded"], initial: "recorded", minSources: 1, keys: (d) => [`run:${textKey(d.query)}|${textKey(d.platform)}|${d.date}|${d.runNumber}`], words: (d) => [d.query, d.platform] }),
  "content-item": kind({ prefix: "CON", schema: contentItem, statuses: ["research", "brief", "draft", "fact-check", "review", "approve", "published", "distributed", "measured", "dropped"], initial: "research", minSources: 0, keys: (d) => [`title:${textKey(d.title)}`], words: (d) => [d.title, d.topic] }),
  prospect: kind({ prefix: "PRO", schema: prospect, statuses: ["identified", "researched", "qualified", "contact-approved", "contacted", "engaged", "opportunity", "customer", "lost"], initial: "identified", minSources: 1, keys: org, words: (d) => [d.organisation, d.useCase, d.website] }),
  interaction: kind({ prefix: "INT", schema: interaction, statuses: ["recorded"], initial: "recorded", minSources: 0, words: (d) => [d.type, d.evidence] }),
  "outreach-draft": kind({ prefix: "OUT", schema: outreachDraft, statuses: ["drafted", "approved", "sent", "withdrawn"], initial: "drafted", minSources: 0, words: (d) => [d.subject] }),
  campaign: kind({ prefix: "CAM", schema: campaign, statuses: ["proposed", "active", "ended", "dropped"], initial: "proposed", minSources: 0, keys: (d) => [`name:${textKey(d.name)}`], words: (d) => [d.name, d.hypothesis, d.channel] }),
  experiment: kind({ prefix: "EXP", schema: experiment, statuses: ["proposed", "running", "evaluated", "scaled", "stopped"], initial: "proposed", minSources: 0, keys: (d) => [`name:${textKey(d.name)}`], words: (d) => [d.name, d.hypothesis, d.channel] }),
  partnership: kind({ prefix: "PAR", schema: partnership, statuses: ["identified", "researched", "drafted", "approved", "submitted", "active", "declined", "dropped"], initial: "identified", minSources: 1, keys: (d) => org(d).map((k) => `${k}:${d.type}`), words: (d) => [d.organisation, d.rationale, d.type] }),
  "community-opportunity": kind({ prefix: "COM", schema: communityOpportunity, statuses: ["identified", "drafted", "approved", "posted", "measured", "dropped"], initial: "identified", minSources: 1, keys: (d) => [`url:${d.url.trim().toLowerCase().replace(/\/+$/, "")}`], words: (d) => [d.venue, d.topic, d.relevance] }),
  "metric-observation": kind({ prefix: "MET", schema: metricObservation, statuses: ["recorded"], initial: "recorded", minSources: 1, keys: (d) => [`obs:${d.name}|${d.period.start}|${d.period.end}|${d.dimension ?? ""}`], words: (d) => [d.name, d.measuredBy] }),
  task: kind({ prefix: "TSK", schema: task, statuses: ["queued", "claimed", "done", "failed", "stalled"], initial: "queued", minSources: 0, words: (d) => [d.taskKind, d.agent, d.reason] }),
  approval: kind({ prefix: "APR", schema: approval, statuses: ["granted"], initial: "granted", minSources: 0, words: (d) => [d.action, d.subjectId] }),
  "budget-entry": kind({ prefix: "BUD", schema: budgetEntry, statuses: ["open", "closed"], initial: "open", minSources: 0, words: (d) => [d.agent, d.taskId] }),
  "market-request": kind({ prefix: "REQ", schema: marketRequest, statuses: ["open", "acknowledged", "answered", "declined"], initial: "open", minSources: 0, keys: (d) => [`title:${textKey(d.title)}`], words: (d) => [d.title, d.detail] }),
  "release-request": kind({ prefix: "REL", schema: releaseRequest, statuses: ["needs-release", "released", "withdrawn"], initial: "needs-release", minSources: 0, keys: (d) => [`title:${textKey(d.title)}`], words: (d) => [d.title, d.what] }),
  "routine-backlog-item": kind({ prefix: "RBL", schema: routineBacklogItem, statuses: ["open", "done", "dropped"], initial: "open", minSources: 0, keys: (d) => [`backlog:${d.routine}|${d.action}|${textKey(d.subject)}`], words: (d) => [d.subject, d.reason] }),
  suppression: kind({ prefix: "SUP", schema: suppression, statuses: ["active"], initial: "active", minSources: 0, keys: (d) => [`org:${orgKey(d.organisation)}`, ...(d.domain ? [`domain:${d.domain.toLowerCase()}`] : [])], words: (d) => [d.organisation] }),
} as const;

export type Kind = keyof typeof KINDS;
export const KIND_NAMES = Object.keys(KINDS) as Kind[];
export type DataOf<K extends Kind> = Infer<(typeof KINDS)[K]["schema"]>;

export function isKind(value: string): value is Kind {
  return value in KINDS;
}

export function kindOfId(id: string): Kind | undefined {
  const prefix = id.split("-")[0];
  return KIND_NAMES.find((name) => KINDS[name].prefix === prefix);
}

// ---------------------------------------------------------------------------
// Records and events
// ---------------------------------------------------------------------------

export type StatusChange = { at: string; from: string | null; to: string; by: Actor; note: string };

export type GtmRecord<K extends Kind = Kind> = {
  id: string;
  kind: K;
  status: string;
  keys: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  updatedBy: Actor;
  sources: Source[];
  data: DataOf<K>;
  history: StatusChange[];
};

/** One entry of the append-only log. Record writes carry the hash of the record as written. */
export type GtmEvent = {
  at: string;
  actor: Actor;
  type: "init" | "create" | "update" | "transition" | "approval" | "fact" | "config" | "orchestrator";
  recordId?: string;
  kind?: Kind;
  from?: string | null;
  to?: string;
  note?: string;
  /** sha256 of the record's canonical JSON after this write. */
  recordHash?: string;
  /** sha256 of config.json's canonical JSON after this write (init and config events). */
  configHash?: string;
  detail?: Record<string, unknown>;
};

export type GtmEventRecord = { seq: number; prevHash: string; eventHash: string; event: GtmEvent };

// ---------------------------------------------------------------------------
// Configuration (lives in the data root, changed only through the store)
// ---------------------------------------------------------------------------

const ceiling = obj({
  runsPerDay: num({ min: 0, int: true }),
  runsPerWeek: num({ min: 0, int: true }),
  costUsdPerDay: num({ min: 0 }),
  costUsdPerWeek: num({ min: 0 }),
});
export type Ceiling = Infer<typeof ceiling>;

export const configSchema = obj({
  version: num({ min: 1, max: 1, int: true }),
  /** True only for the demo's throwaway root. Reports and the dashboard carry a banner. */
  fictional: bool,
  /** The people whose name approve, record, suppress and budget set accept. */
  approvers: arr(text, { min: 1 }),
  budgets: obj({
    overall: ceiling,
    agents: obj(Object.fromEntries(AGENTS.map((name) => [name, ceiling])) as Record<AgentName, typeof ceiling>),
  }),
  /** An assumed cost of one agent run, used until a run reports its own estimate. Not a bill. */
  costEstimateUsdPerRun: num({ min: 0 }),
  taskTimeLimitMinutes: num({ min: 1, int: true }),
  /** The orchestrator opens at most one Growth Director review per this many hours. */
  reviewIntervalHours: num({ min: 1 }),
});
export type GtmConfig = Infer<typeof configSchema>;

/**
 * The budget a store starts with. Harry, 2026-11-25: "Start small: 10 a week".
 * At most 10 agent runs a week across all eight agents, 2 on any one day, and
 * per-agent weekly ceilings that sum to the total (the Growth Director's
 * weekly review is one of its runs). The cost figures are the same ceilings
 * under an assumed 1 USD a run; they are an assumption, not a measured bill.
 */
export function defaultConfig(): GtmConfig {
  const one: Ceiling = { runsPerDay: 1, runsPerWeek: 1, costUsdPerDay: 2, costUsdPerWeek: 2 };
  const two: Ceiling = { runsPerDay: 1, runsPerWeek: 2, costUsdPerDay: 2, costUsdPerWeek: 4 };
  return {
    version: 1,
    fictional: false,
    approvers: ["Harry"],
    budgets: {
      overall: { runsPerDay: 2, runsPerWeek: 10, costUsdPerDay: 4, costUsdPerWeek: 10 },
      agents: {
        "market-intelligence": { ...one },
        "geo-seo": { ...two },
        content: { ...one },
        outbound: { ...one },
        partnerships: { ...one },
        conversion: { ...one },
        community: { ...one },
        "growth-director": { ...two },
      },
    },
    costEstimateUsdPerRun: 1,
    taskTimeLimitMinutes: 90,
    reviewIntervalHours: 24,
  };
}

/** Rules a config must keep beyond its shape. Returns the problems, empty when sound. */
export function configProblems(config: GtmConfig): string[] {
  const problems: string[] = [];
  const { overall, agents } = config.budgets;
  const weekly = AGENTS.reduce((sum, name) => sum + agents[name].runsPerWeek, 0);
  if (weekly > overall.runsPerWeek) {
    problems.push(`per-agent weekly run ceilings sum to ${weekly}, more than the overall ${overall.runsPerWeek}`);
  }
  if (overall.runsPerDay > overall.runsPerWeek) problems.push("the overall daily run ceiling is above the weekly one");
  for (const name of AGENTS) {
    if (agents[name].runsPerDay > agents[name].runsPerWeek) problems.push(`${name}: the daily run ceiling is above the weekly one`);
  }
  return problems;
}
