// Permission boundaries for the go-to-market agents.
//
// Same idea as lab/permissions.ts: no agent has unrestricted access, and the
// store refuses any write the acting agent is not entitled to make. The Lab's
// table is typed to its own roles and capabilities, so this one follows its
// pattern rather than importing it.
//
// A grant names, per agent: the record kinds it may create, the fields it may
// edit on each kind, and the status moves it may make. Four kinds are in no
// agent's grant at all, whatever this table says elsewhere:
//   approval     written only by the store's approve(), for a named person
//   interaction  written only by recordFact(), for a named person
//   suppression  written only by suppress(), for a named person
//   task, budget-entry  written only by the orchestrator

import { AGENTS, isAgent, isHuman, type Actor, type AgentName, type Kind } from "./types.js";
import { MACHINES } from "./machines.js";

export type Grant = {
  create: readonly Kind[];
  /** Fields of `data` the agent may edit; "*" is every field. */
  update: Partial<Record<Kind, readonly string[] | "*">>;
  /** Moves the agent may make, as "from>to". */
  move: Partial<Record<Kind, readonly string[]>>;
};

/** Kinds no agent may write, by any route. */
export const HUMAN_ONLY_KINDS: readonly Kind[] = ["approval", "interaction", "suppression"];
export const ORCHESTRATOR_ONLY_KINDS: readonly Kind[] = ["task", "budget-entry"];

const EXPERIMENT_PROPOSAL = ["name", "audience", "problem", "hypothesis", "channel", "budget", "objective", "period", "evaluationMethod", "campaignId"];
const CONTENT_AUTHOR = ["title", "topic", "format", "targetQueryIds", "opportunityId", "researchNotes", "brief", "draft"];
const CONTENT_AUTHOR_MOVES = ["research>brief", "brief>draft", "draft>fact-check", "research>dropped", "brief>dropped", "draft>dropped"];
// Any of these may check a draft, but the store refuses the agent that drafted it.
const FACT_CHECK = ["fact-check>review", "fact-check>draft"];
const RELEASE_FIELDS = ["title", "what", "recordIds"];
const SET_ASIDE = ["identified>lost", "researched>lost", "qualified>lost"];

export const GRANTS: Record<AgentName, Grant> = {
  "market-intelligence": {
    create: ["market-segment", "customer-profile", "competitor", "buying-signal", "opportunity", "market-request"],
    update: { "market-segment": "*", "customer-profile": "*", competitor: "*", "buying-signal": "*", opportunity: "*", "market-request": ["title", "detail", "motivationIds", "priority", "requestKind"] },
    move: {
      "market-segment": ["draft>validated", "validated>retired", "draft>retired"],
      "customer-profile": ["draft>validated", "validated>retired", "draft>retired"],
      competitor: ["tracked>retired"],
      "buying-signal": ["new>linked", "new>dismissed"],
      opportunity: ["open>in-progress", "open>dropped", "in-progress>dropped"],
      "content-item": FACT_CHECK,
    },
  },
  "geo-seo": {
    create: ["search-query", "visibility-test", "opportunity", "metric-observation", "experiment", "content-item", "routine-backlog-item", "release-request"],
    update: { "search-query": "*", "content-item": ["targetQueryIds", "researchNotes"], experiment: EXPERIMENT_PROPOSAL, opportunity: "*", "routine-backlog-item": "*", "release-request": RELEASE_FIELDS },
    move: {
      "routine-backlog-item": ["open>done", "open>dropped"],
      "release-request": ["needs-release>withdrawn"],
      "search-query": ["active>retired"],
      "content-item": [...FACT_CHECK, "published>measured", "distributed>measured"],
      opportunity: ["open>in-progress", "open>dropped"],
    },
  },
  content: {
    create: ["content-item", "experiment", "market-request", "release-request"],
    update: { "content-item": CONTENT_AUTHOR, experiment: EXPERIMENT_PROPOSAL, "release-request": RELEASE_FIELDS },
    move: {
      "release-request": ["needs-release>withdrawn"],
      "content-item": [...CONTENT_AUTHOR_MOVES, ...FACT_CHECK],
      opportunity: ["open>in-progress", "in-progress>converted"],
    },
  },
  outbound: {
    create: ["prospect", "buying-signal", "outreach-draft"],
    update: {
      prospect: ["website", "organisationType", "useCase", "publicSignals", "spendSignal", "qualification", "contactRoutes", "collection", "lawfulBasis", "optOut", "sourceStatus", "angle", "notes", "segmentId", "opportunityId", "lostReason"],
      "buying-signal": "*",
      "outreach-draft": ["route", "subject", "body", "figures"],
    },
    move: {
      prospect: ["identified>researched", "researched>qualified", ...SET_ASIDE],
      "buying-signal": ["new>linked", "new>dismissed"],
      "outreach-draft": ["drafted>withdrawn", "approved>withdrawn"],
    },
  },
  partnerships: {
    create: ["partnership", "opportunity"],
    update: { partnership: "*" },
    move: {
      partnership: ["identified>researched", "researched>drafted", "identified>dropped", "researched>dropped", "drafted>dropped"],
      opportunity: ["open>in-progress"],
    },
  },
  conversion: {
    create: ["metric-observation", "experiment", "opportunity", "content-item", "market-request", "release-request"],
    update: { "content-item": CONTENT_AUTHOR, experiment: EXPERIMENT_PROPOSAL, "release-request": RELEASE_FIELDS },
    move: { "release-request": ["needs-release>withdrawn"], "content-item": [...CONTENT_AUTHOR_MOVES, ...FACT_CHECK, "published>measured", "distributed>measured"] },
  },
  community: {
    create: ["community-opportunity"],
    update: { "community-opportunity": "*" },
    move: { "community-opportunity": ["identified>drafted", "identified>dropped", "drafted>dropped", "posted>measured"] },
  },
  "growth-director": {
    create: ["campaign", "experiment", "opportunity", "market-request"],
    update: { campaign: "*", experiment: "*", opportunity: "*", "content-item": ["review"] },
    move: {
      campaign: ["proposed>active", "active>ended", "proposed>dropped"],
      experiment: ["proposed>running", "running>evaluated", "evaluated>scaled", "evaluated>stopped", "proposed>stopped"],
      opportunity: ["open>in-progress", "in-progress>converted", "open>dropped", "in-progress>dropped"],
      "content-item": [...FACT_CHECK, "review>draft", "review>dropped"],
      prospect: SET_ASIDE,
      "outreach-draft": ["drafted>withdrawn", "approved>withdrawn"],
    },
  },
};

const ORCHESTRATOR: Grant = {
  create: ["task", "budget-entry", "opportunity"],
  update: { task: "*", "budget-entry": "*" },
  move: { task: MACHINES.task.map((e) => `${e.from}>${e.to}`), "budget-entry": ["open>closed"] },
};

const IMPORTER: Grant = {
  create: ["prospect", "search-query", "visibility-test", "metric-observation"],
  update: { prospect: "*", "search-query": "*", "visibility-test": "*", "metric-observation": "*" },
  move: {},
};

function grantOf(actor: Actor): Grant | "human" | undefined {
  if (isAgent(actor)) return GRANTS[actor];
  if (actor === "orchestrator") return ORCHESTRATOR;
  if (actor === "importer") return IMPORTER;
  if (isHuman(actor)) return "human";
  return undefined;
}

export type Attempt =
  | { op: "create"; kind: Kind }
  | { op: "update"; kind: Kind; field: string }
  | { op: "move"; kind: Kind; from: string; to: string };

/**
 * May this actor make this write through the general path? A person may write
 * any ordinary record; nobody, a person included, creates an approval, an
 * interaction or a suppression here (the store's own commands do), and only
 * the orchestrator writes tasks and budget entries.
 */
export function can(actor: Actor, attempt: Attempt): boolean {
  const grant = grantOf(actor);
  if (!grant) return false;
  if (HUMAN_ONLY_KINDS.includes(attempt.kind)) return false;
  if (ORCHESTRATOR_ONLY_KINDS.includes(attempt.kind) && actor !== "orchestrator") return false;
  if (grant === "human") return true;
  if (attempt.op === "create") return grant.create.includes(attempt.kind);
  if (attempt.op === "update") {
    const fields = grant.update[attempt.kind];
    return fields === "*" || (fields?.includes(attempt.field) ?? false);
  }
  return grant.move[attempt.kind]?.includes(`${attempt.from}>${attempt.to}`) ?? false;
}

export class PermissionError extends Error {
  constructor(
    readonly actor: string,
    readonly attempt: Attempt,
  ) {
    const what =
      attempt.op === "create"
        ? `create a ${attempt.kind} record`
        : attempt.op === "update"
          ? `edit "${attempt.field}" on a ${attempt.kind} record`
          : `move a ${attempt.kind} record from "${attempt.from}" to "${attempt.to}"`;
    super(`"${actor}" is not permitted to ${what}.`);
    this.name = "PermissionError";
  }
}

export function assertCan(actor: Actor, attempt: Attempt): void {
  if (!can(actor, attempt)) throw new PermissionError(actor, attempt);
}

/** A rule of the pipeline refused the write: a missing approval, a suppressed prospect, a self-check. */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

/** A plain-English rendering of one agent's grant, for its definition page. */
export function describeGrant(agent: AgentName): string[] {
  const grant = GRANTS[agent];
  const lines = [`May create: ${grant.create.join(", ") || "nothing"}.`];
  for (const [kind, fields] of Object.entries(grant.update)) {
    lines.push(`May edit on ${kind}: ${fields === "*" ? "every field" : (fields as readonly string[]).join(", ")}.`);
  }
  for (const [kind, moves] of Object.entries(grant.move)) {
    lines.push(`May move ${kind}: ${(moves as readonly string[]).map((m) => m.replace(">", " to ")).join("; ")}.`);
  }
  return lines;
}

export { AGENTS };
