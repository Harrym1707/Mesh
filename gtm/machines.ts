// The pipelines, as explicit state machines.
//
// A record's status only ever changes along an edge listed here. Three kinds
// of edge are special, and the store (not a prompt) enforces each:
//
//   fact          the move records something that happened in the world
//                 (contacted, engaged, customer, published, distributed,
//                 posted, submitted). Only `gtm record`, run by a person and
//                 naming the evidence, makes it. The engine never infers it.
//   needsApproval the move is refused unless a granted approval for that
//                 action covers the record.
//   onApproval    the move the `approve` command itself makes when a person
//                 approves that action. Nothing else can make it.

import type { Kind } from "./types.js";

export type ApprovalAction = "contact" | "publish" | "distribute" | "post" | "submit";

export type Edge = {
  from: string;
  to: string;
  fact?: true;
  needsApproval?: ApprovalAction;
  onApproval?: ApprovalAction;
};

function chain(...pairs: string[]): Edge[] {
  return pairs.map((pair) => {
    const [from, to] = pair.split(">") as [string, string];
    return { from, to };
  });
}

/**
 * Prospects: identified, researched, qualified, contact approved, contacted,
 * engaged, opportunity, customer, lost. Everything from "contact approved"
 * onward needs Harry's approval of the contact, and everything after it is a
 * fact he reports.
 */
const PROSPECT: Edge[] = [
  ...chain("identified>researched", "researched>qualified"),
  { from: "qualified", to: "contact-approved", onApproval: "contact" },
  { from: "contact-approved", to: "contacted", fact: true, needsApproval: "contact" },
  { from: "contacted", to: "engaged", fact: true, needsApproval: "contact" },
  { from: "engaged", to: "opportunity", fact: true, needsApproval: "contact" },
  { from: "opportunity", to: "customer", fact: true, needsApproval: "contact" },
  // Before any contact, the engine may set a prospect aside with its reason.
  ...chain("identified>lost", "researched>lost", "qualified>lost"),
  // After it, "lost" is something a person learned.
  ...["contact-approved", "contacted", "engaged", "opportunity"].map((from): Edge => ({ from, to: "lost", fact: true })),
];

/**
 * Content: research, brief, draft, fact-check, review, approve, publish,
 * distribute, measure. A status names the stage the item is in; "approve"
 * means approved for publication, and is reached only by Harry's approval.
 */
const CONTENT: Edge[] = [
  ...chain("research>brief", "brief>draft", "draft>fact-check", "fact-check>review"),
  // A failed check or a review that asks for changes sends the item back.
  ...chain("fact-check>draft", "review>draft"),
  { from: "review", to: "approve", onApproval: "publish" },
  { from: "approve", to: "published", fact: true, needsApproval: "publish" },
  { from: "published", to: "distributed", fact: true, needsApproval: "distribute" },
  ...chain("published>measured", "distributed>measured"),
  ...chain("research>dropped", "brief>dropped", "draft>dropped", "fact-check>dropped", "review>dropped"),
];

/** Experiments: proposed, running, evaluated, then scaled or stopped. */
const EXPERIMENT: Edge[] = chain("proposed>running", "running>evaluated", "evaluated>scaled", "evaluated>stopped", "proposed>stopped");

const OUTREACH: Edge[] = [
  { from: "drafted", to: "approved", onApproval: "contact" },
  { from: "approved", to: "sent", fact: true, needsApproval: "contact" },
  ...chain("drafted>withdrawn", "approved>withdrawn"),
];

const COMMUNITY: Edge[] = [
  ...chain("identified>drafted"),
  { from: "drafted", to: "approved", onApproval: "post" },
  { from: "approved", to: "posted", fact: true, needsApproval: "post" },
  ...chain("posted>measured", "identified>dropped", "drafted>dropped"),
];

const PARTNERSHIP: Edge[] = [
  ...chain("identified>researched", "researched>drafted"),
  { from: "drafted", to: "approved", onApproval: "submit" },
  { from: "approved", to: "submitted", fact: true, needsApproval: "submit" },
  { from: "submitted", to: "active", fact: true, needsApproval: "submit" },
  { from: "submitted", to: "declined", fact: true },
  ...chain("identified>dropped", "researched>dropped", "drafted>dropped"),
];

const TASK: Edge[] = chain("queued>claimed", "claimed>done", "claimed>failed", "claimed>stalled", "stalled>queued", "stalled>failed", "queued>failed");

export const MACHINES: Record<Kind, Edge[]> = {
  prospect: PROSPECT,
  "content-item": CONTENT,
  experiment: EXPERIMENT,
  "outreach-draft": OUTREACH,
  "community-opportunity": COMMUNITY,
  partnership: PARTNERSHIP,
  task: TASK,
  campaign: chain("proposed>active", "active>ended", "proposed>dropped"),
  "market-segment": chain("draft>validated", "validated>retired", "draft>retired"),
  "customer-profile": chain("draft>validated", "validated>retired", "draft>retired"),
  competitor: chain("tracked>retired"),
  "buying-signal": chain("new>linked", "new>dismissed"),
  opportunity: chain("open>in-progress", "in-progress>converted", "open>dropped", "in-progress>dropped"),
  "search-query": chain("active>retired"),
  "market-request": chain("open>acknowledged", "acknowledged>answered", "open>answered", "open>declined", "acknowledged>declined"),
  "budget-entry": chain("open>closed"),
  // "released" is a fact the Command Center's release makes true, with its evidence.
  "release-request": [{ from: "needs-release", to: "released", fact: true }, ...chain("needs-release>withdrawn")],
  "routine-backlog-item": chain("open>done", "open>dropped"),
  "visibility-test": [],
  "metric-observation": [],
  interaction: [],
  approval: [],
  suppression: [],
};

export function findEdge(kind: Kind, from: string, to: string): Edge | undefined {
  return MACHINES[kind].find((edge) => edge.from === from && edge.to === to);
}

/**
 * Statuses reached through an approval or a reported fact. Once a record is in
 * one, no agent may edit it: what Harry approved is what stays on file.
 */
export const LOCKED: Partial<Record<Kind, readonly string[]>> = {
  prospect: ["contact-approved", "contacted", "engaged", "opportunity", "customer"],
  "outreach-draft": ["approved", "sent"],
  "content-item": ["approve", "published", "distributed"],
  "community-opportunity": ["approved", "posted"],
  partnership: ["approved", "submitted", "active"],
};

/** Which record kinds each approval covers, and the status the record must be in. */
export const APPROVABLE: Record<ApprovalAction, Partial<Record<Kind, readonly string[]>>> = {
  contact: { prospect: ["qualified"], "outreach-draft": ["drafted"] },
  publish: { "content-item": ["review"] },
  distribute: { "content-item": ["approve", "published"] },
  post: { "community-opportunity": ["drafted"] },
  submit: { partnership: ["drafted"] },
};

/** Extra fields a move may write, beyond what the actor may edit at rest. */
export function edgeFields(kind: Kind, from: string, to: string): string[] {
  if (kind === "content-item") {
    if (from === "fact-check") return ["factCheck"];
    if (from === "review" && to === "draft") return ["review"];
    if (to === "measured") return ["performance"];
  }
  if (kind === "prospect" && to === "lost") return ["lostReason"];
  if (kind === "experiment") return ["result", "decision"];
  return [];
}
