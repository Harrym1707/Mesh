// The persistent Research & Optimisation Ledger — the lab's durable shared
// memory. All agents read from it; each writes only what its role permits.
//
// Storage (plain files, so it is auditable and git-diffable like the rest of
// Mesh's ledgers):
//   <root>/meta.json            - id counter
//   <root>/records/<id>.json    - the current state of each optimisation
//   <root>/events.jsonl         - append-only, hash-chained audit trail
//   <root>/portfolio.json       - the promoted-lever set (self-documenting)
//   <root>/workspaces/<id>/     - the Builder's isolated experiment workspace
//
// The event log is hash-chained exactly like packages/core/src/savings-ledger
// (sha256 over seq, prevHash and the canonical event), so any reordering,
// edit or deletion of history is detectable with verifyIntegrity().

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  isTerminal,
  type LeadStatus,
  type LedgerEvent,
  type LedgerEventRecord,
  type OptimisationLead,
  type OptimisationRecord,
  type PromotedLever,
  type StatusChange,
  type WorkloadShape,
} from "./types.js";
import {
  assertCan,
  capabilityForStatus,
  type AgentRole,
  type Capability,
} from "./permissions.js";

const GENESIS_HASH = "0".repeat(64);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    // Skip undefined-valued keys so the canonical form matches what
    // JSON.stringify writes to disk (it drops them) — otherwise the hash
    // computed at write time would not match the one recomputed on read.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function eventHash(seq: number, prevHash: string, event: LedgerEvent): string {
  return createHash("sha256")
    .update(`${seq}\n${prevHash}\n${canonicalJson(event)}`)
    .digest("hex");
}

export function fingerprint(category: string, techniqueKey: string): string {
  return createHash("sha256")
    .update(`${category}::${techniqueKey.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

export class DuplicateLeadError extends Error {
  constructor(
    readonly fingerprint: string,
    readonly priorId: string,
    readonly priorStatus: LeadStatus,
  ) {
    super(
      `A lead with fingerprint ${fingerprint} already exists (${priorId}, status ${priorStatus}). ` +
        `Supply a newReason to re-investigate.`,
    );
    this.name = "DuplicateLeadError";
  }
}

export type CreateLeadOptions = {
  /** Required to re-open an idea that has already settled (failed/rejected/inconclusive). */
  newReason?: string;
};

export type ShapeCoverage = {
  total: number;
  promoted: number;
  /** Lossy levers with a measured saving, waiting on a real replay gate. */
  needsGate: number;
  inconclusive: number;
  rejected: number;
  failed: number;
};

export type LedgerClock = () => string;

export type LabLedgerOptions = {
  now?: LedgerClock;
};

export class LabLedger {
  private readonly root: string;
  private readonly now: LedgerClock;

  constructor(root: string, options: LabLedgerOptions = {}) {
    this.root = root;
    this.now = options.now ?? (() => new Date().toISOString());
    this.init();
  }

  // --- paths -------------------------------------------------------------
  private metaPath() {
    return join(this.root, "meta.json");
  }
  private recordsDir() {
    return join(this.root, "records");
  }
  private recordPath(id: string) {
    return join(this.recordsDir(), `${id}.json`);
  }
  private eventsPath() {
    return join(this.root, "events.jsonl");
  }
  private portfolioPath() {
    return join(this.root, "portfolio.json");
  }
  workspaceDir(id: string) {
    return join(this.root, "workspaces", id);
  }

  private init(): void {
    mkdirSync(this.recordsDir(), { recursive: true });
    mkdirSync(join(this.root, "workspaces"), { recursive: true });
    if (!existsSync(this.metaPath())) {
      writeFileSync(this.metaPath(), `${JSON.stringify({ seq: 0 }, null, 2)}\n`);
    }
    if (!existsSync(this.eventsPath())) writeFileSync(this.eventsPath(), "");
    if (!existsSync(this.portfolioPath())) {
      writeFileSync(this.portfolioPath(), `${JSON.stringify({ levers: [] }, null, 2)}\n`);
    }
  }

  // --- id allocation -----------------------------------------------------
  private nextId(): string {
    const meta = JSON.parse(readFileSync(this.metaPath(), "utf8")) as { seq: number };
    meta.seq += 1;
    writeFileSync(this.metaPath(), `${JSON.stringify(meta, null, 2)}\n`);
    return `OPT-${String(meta.seq).padStart(4, "0")}`;
  }

  // --- event log ---------------------------------------------------------
  private readEvents(): LedgerEventRecord[] {
    const raw = readFileSync(this.eventsPath(), "utf8").trim();
    if (raw === "") return [];
    return raw.split("\n").map((line) => JSON.parse(line) as LedgerEventRecord);
  }

  private appendEvent(event: LedgerEvent): LedgerEventRecord {
    const events = this.readEvents();
    const prev = events.at(-1);
    const seq = prev ? prev.seq + 1 : 0;
    const prevHash = prev ? prev.eventHash : GENESIS_HASH;
    const record: LedgerEventRecord = {
      seq,
      prevHash,
      eventHash: eventHash(seq, prevHash, event),
      event,
    };
    appendFileSync(this.eventsPath(), `${JSON.stringify(record)}\n`);
    return record;
  }

  events(): LedgerEventRecord[] {
    return this.readEvents();
  }

  /** Verify the hash chain end-to-end; reports the first break. */
  verifyIntegrity(): { ok: true; length: number } | { ok: false; seq: number; reason: string } {
    const events = this.readEvents();
    let prevHash = GENESIS_HASH;
    for (let index = 0; index < events.length; index += 1) {
      const record = events[index]!;
      if (record.seq !== index)
        return { ok: false, seq: record.seq, reason: `Expected seq ${index}, found ${record.seq}.` };
      if (record.prevHash !== prevHash)
        return { ok: false, seq: record.seq, reason: "prevHash does not match preceding record." };
      if (record.eventHash !== eventHash(record.seq, record.prevHash, record.event))
        return { ok: false, seq: record.seq, reason: "eventHash does not match event content." };
      prevHash = record.eventHash;
    }
    return { ok: true, length: events.length };
  }

  // --- records -----------------------------------------------------------
  getRecord(id: string): OptimisationRecord | undefined {
    const path = this.recordPath(id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as OptimisationRecord;
  }

  private writeRecord(record: OptimisationRecord): void {
    writeFileSync(this.recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  listRecords(filter?: { status?: LeadStatus; category?: string }): OptimisationRecord[] {
    if (!existsSync(this.recordsDir())) return [];
    const records = readdirSync(this.recordsDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(this.recordsDir(), name), "utf8")) as OptimisationRecord)
      .sort((a, b) => a.id.localeCompare(b.id));
    return records.filter(
      (r) =>
        (filter?.status === undefined || r.status === filter.status) &&
        (filter?.category === undefined || r.category === filter.category),
    );
  }

  findByFingerprint(fp: string): OptimisationRecord | undefined {
    return this.listRecords().find((r) => r.fingerprint === fp);
  }

  // --- lead intake -------------------------------------------------------
  createLead(role: AgentRole, lead: OptimisationLead, options: CreateLeadOptions = {}): OptimisationRecord {
    assertCan(role, "lead:create");
    const fp = fingerprint(lead.category, lead.techniqueKey);
    const prior = this.findByFingerprint(fp);
    if (prior) {
      const settled = isTerminal(prior.status);
      if (!settled) throw new DuplicateLeadError(fp, prior.id, prior.status);
      if (!options.newReason) throw new DuplicateLeadError(fp, prior.id, prior.status);
      // Re-opening a settled idea is allowed only with a new reason; it is
      // logged against the prior record so the trail shows why.
      this.appendEvent({
        at: this.now(),
        recordId: prior.id,
        actor: role,
        type: "note",
        detail: { reopenedWithReason: options.newReason },
      });
    }

    const id = this.nextId();
    const at = this.now();
    const record: OptimisationRecord = {
      id,
      title: lead.title,
      description: lead.description,
      category: lead.category,
      bucket: lead.bucket,
      status: "discovered",
      fingerprint: fp,
      techniqueKey: lead.techniqueKey,
      source: lead.source,
      hypothesis: lead.hypothesis,
      lead,
      expectedSavingPercent: lead.expectedTokenReductionPercent,
      codeLinks: [],
      createdAt: at,
      updatedAt: at,
      history: [{ at, from: null, to: "discovered", by: role, note: "Lead discovered." }],
    };
    this.writeRecord(record);
    this.appendEvent({
      at,
      recordId: id,
      actor: role,
      type: "discovered",
      to: "discovered",
      detail: {
        title: lead.title,
        category: lead.category,
        bucket: lead.bucket,
        techniqueKey: lead.techniqueKey,
        reopenedFrom: prior?.id,
      },
    });
    return record;
  }

  // --- stage advance -----------------------------------------------------
  /**
   * Advance a record to the next status. The capability required is derived
   * from the record's CURRENT status, so only the agent responsible for that
   * stage can move it — this is what keeps the Builder from promoting and the
   * Evaluator logically separate from the Builder.
   */
  advance(
    role: AgentRole,
    id: string,
    to: LeadStatus,
    patch: Partial<OptimisationRecord>,
    note: string,
    eventType: LedgerEvent["type"] = "status-change",
    eventDetail: Record<string, unknown> = {},
  ): OptimisationRecord {
    const record = this.getRecord(id);
    if (!record) throw new Error(`No such record: ${id}`);
    const required: Capability | null = capabilityForStatus(record.status);
    if (required === null) {
      throw new Error(`Record ${id} is in terminal status ${record.status}; cannot advance.`);
    }
    assertCan(role, required);

    const at = this.now();
    const from = record.status;
    const change: StatusChange = { at, from, to, by: role, note };
    const updated: OptimisationRecord = {
      ...record,
      ...patch,
      id: record.id,
      status: to,
      updatedAt: at,
      history: [...record.history, change],
    };
    this.writeRecord(updated);
    this.appendEvent({ at, recordId: id, actor: role, type: eventType, from, to, detail: eventDetail });
    return updated;
  }

  /** Emit a standalone audit note without changing status (read capability only). */
  note(role: AgentRole, id: string, type: LedgerEvent["type"], detail: Record<string, unknown>): void {
    assertCan(role, "record:read");
    this.appendEvent({ at: this.now(), recordId: id, actor: role, type, detail });
  }

  // --- portfolio ---------------------------------------------------------
  readPortfolio(): { levers: PromotedLever[] } {
    return JSON.parse(readFileSync(this.portfolioPath(), "utf8")) as { levers: PromotedLever[] };
  }

  addToPortfolio(role: AgentRole, lever: PromotedLever): void {
    assertCan(role, "portfolio:write");
    const portfolio = this.readPortfolio();
    portfolio.levers = portfolio.levers.filter((l) => l.id !== lever.id);
    portfolio.levers.push(lever);
    writeFileSync(this.portfolioPath(), `${JSON.stringify(portfolio, null, 2)}\n`);
  }

  // --- learning ----------------------------------------------------------
  /**
   * Outcome tally per category, used to bias future research toward what works
   * and away from what consistently fails. Promotions count positively,
   * failures/rejections negatively; inconclusive is neutral.
   */
  categoryOutcomes(): Record<string, { promoted: number; failed: number; rejected: number; inconclusive: number }> {
    const tally: Record<string, { promoted: number; failed: number; rejected: number; inconclusive: number }> = {};
    for (const record of this.listRecords()) {
      const bucket = (tally[record.category] ??= { promoted: 0, failed: 0, rejected: 0, inconclusive: 0 });
      if (record.status === "promoted") bucket.promoted += 1;
      else if (record.status === "failed") bucket.failed += 1;
      else if (record.status === "rejected") bucket.rejected += 1;
      else if (record.status === "inconclusive") bucket.inconclusive += 1;
    }
    return tally;
  }

  /**
   * Coverage across the three traffic verticals — so the lab can see it is
   * working the agentic shapes (where the spend compounds), not just one-shot.
   */
  coverageByShape(): Record<WorkloadShape, ShapeCoverage> {
    const shapes: WorkloadShape[] = ["always-on-agent", "autonomous-agent", "one-shot"];
    const tally = Object.fromEntries(
      shapes.map((s) => [s, { total: 0, promoted: 0, needsGate: 0, inconclusive: 0, rejected: 0, failed: 0 }]),
    ) as Record<WorkloadShape, ShapeCoverage>;
    for (const record of this.listRecords()) {
      const shape = record.lead?.shape ?? "one-shot";
      const bucket = tally[shape];
      bucket.total += 1;
      if (record.status === "promoted") bucket.promoted += 1;
      else if (record.status === "needs_gate") bucket.needsGate += 1;
      else if (record.status === "inconclusive") bucket.inconclusive += 1;
      else if (record.status === "rejected") bucket.rejected += 1;
      else if (record.status === "failed") bucket.failed += 1;
    }
    return tally;
  }
}
