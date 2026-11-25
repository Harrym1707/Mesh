// The go-to-market store: the engine's persistent commercial memory.
//
// Built like lab/ledger.ts: plain files, a current-state file per record, and
// an append-only hash-chained event log beside them, so any edit, reordering
// or deletion of history is detectable (`gtm verify`).
//
//   <root>/config.json            budgets and the names of the people who approve
//   <root>/meta.json              id counters
//   <root>/events.jsonl           the hash-chained log
//   <root>/records/<kind>/<id>.json   the current state of each record
//
// The root is PRIVATE and lives outside the product repository, which is
// public: prospects, pipeline history and commercial performance are never
// committed there. The store refuses to open a root inside this checkout or
// inside any git work tree whose remote is the public repository.
//
// Every write is validated against its kind's schema, checked against the
// permission table (permissions.ts) and the pipelines (machines.ts), and
// applied in one transaction: a write that fails leaves nothing behind.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chainEvent, contentHash, verifyChain } from "./chain.js";
import { draftProblems, type NumbersIndex } from "./claims.js";
import { APPROVABLE, LOCKED, edgeFields, findEdge, type ApprovalAction, type Edge } from "./machines.js";
import { GateError, assertCan, can } from "./permissions.js";
import { SchemaError, validate, type Issue } from "./schema.js";
import {
  KINDS,
  KIND_NAMES,
  ROLE_MAILBOXES,
  configProblems,
  configSchema,
  defaultConfig,
  domainOf,
  isAgent,
  isHuman,
  kindOfId,
  orgKey,
  sourceSchema,
  textKey,
  type Actor,
  type DataOf,
  type DeclaredFigure,
  type GtmConfig,
  type GtmEvent,
  type GtmEventRecord,
  type GtmRecord,
  type Kind,
  type Source,
} from "./types.js";

// ---------------------------------------------------------------------------
// Where the data lives
// ---------------------------------------------------------------------------

/** Remotes of the public product repository. A data root under one of these is refused. */
export const PUBLIC_REMOTE = /github\.com[:/]+harrym1707\/mesh(?:\.git)?\/?$/i;

/** The checkout this code runs from. Data is never written inside it. */
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function defaultDataRoot(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.MESH_GTM_DATA?.trim() || join(homedir(), "Desktop", "MESH", "gtm-data"));
}

export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyError";
  }
}

function remotesOf(gitEntry: string): string[] {
  // `.git` is a directory in a main checkout and a file ("gitdir: …") in a work tree.
  let gitDir = gitEntry;
  if (statSync(gitEntry).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitEntry, "utf8"))?.[1]?.trim();
    if (!pointer) return [];
    gitDir = resolve(dirname(gitEntry), pointer);
    const common = join(gitDir, "commondir");
    if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
  }
  const config = join(gitDir, "config");
  if (!existsSync(config)) return [];
  return [...readFileSync(config, "utf8").matchAll(/^\s*url\s*=\s*(\S+)\s*$/gm)].map((m) => m[1]!);
}

/** Throws unless `root` is somewhere the public repository can never pick it up. */
export function assertPrivateRoot(root: string, codeRoot: string = CODE_ROOT): void {
  const target = resolve(root);
  if (target === codeRoot || target.startsWith(codeRoot + sep)) {
    throw new PrivacyError(`The data root ${target} is inside the product checkout ${codeRoot}. Commercial data is never written into the repository.`);
  }
  for (let dir = target; ; dir = dirname(dir)) {
    const gitEntry = join(dir, ".git");
    if (existsSync(gitEntry)) {
      const remote = remotesOf(gitEntry).find((url) => PUBLIC_REMOTE.test(url));
      if (remote) {
        throw new PrivacyError(`The data root ${target} is inside the git work tree ${dir}, whose remote is the public repository (${remote}).`);
      }
    }
    if (dirname(dir) === dir) break;
  }
}

// ---------------------------------------------------------------------------
// Errors and small types
// ---------------------------------------------------------------------------

export class DuplicateRecordError extends Error {
  constructor(
    readonly kind: Kind,
    readonly priorId: string,
  ) {
    super(`This ${kind} is already on file as ${priorId}. Update that record instead of adding it again.`);
    this.name = "DuplicateRecordError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type StoreOptions = {
  now?: () => string;
  /** The labelled figures of docs/NUMBERS.md, for the draft check. */
  numbers?: () => NumbersIndex | undefined;
  /** For tests of the privacy rule only. */
  codeRoot?: string;
};

export type WriteOptions = { sources?: Source[]; note?: string };
export type WriteOutcome<K extends Kind = Kind> = { record: GtmRecord<K>; outcome: "created" | "updated" | "unchanged" };
export type VerifyResult =
  | { ok: true; events: number; records: number; head: string }
  | { ok: false; problems: string[] };

type Data = Record<string, unknown>;
type Internal = { approval?: true; fact?: true; system?: true };
type Tx = { records: Map<string, GtmRecord>; events: GtmEvent[]; counters: Record<string, number>; config?: GtmConfig };

const today = (iso: string) => iso.slice(0, 10);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function mergeSources(existing: readonly Source[], added: readonly Source[]): Source[] {
  const merged = [...existing];
  for (const source of added) {
    if (!merged.some((s) => s.url === source.url && s.readOn === source.readOn)) merged.push(source);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class GtmStore {
  readonly root: string;
  private readonly now: () => string;
  private readonly numbers: () => NumbersIndex | undefined;
  private tx?: Tx;

  private constructor(root: string, options: StoreOptions) {
    this.root = resolve(root);
    assertPrivateRoot(this.root, options.codeRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.numbers = options.numbers ?? (() => undefined);
  }

  /** Create a store. Safe to call on one that exists: it is opened unchanged. */
  static init(root: string, options: StoreOptions & { config?: GtmConfig } = {}): GtmStore {
    const store = new GtmStore(root, options);
    if (existsSync(store.path("config.json"))) return GtmStore.open(root, options);
    const config = validate(configSchema, options.config ?? defaultConfig(), "The configuration");
    const problems = configProblems(config);
    if (problems.length > 0) throw new ConfigError(`The configuration is not sound: ${problems.join("; ")}.`);
    mkdirSync(store.path("records"), { recursive: true });
    writeFileSync(store.path("meta.json"), json({ counters: {} }));
    writeFileSync(store.path("events.jsonl"), "");
    store.mutate(() => {
      store.tx!.config = config;
      store.log({ at: store.now(), actor: "orchestrator", type: "init", configHash: contentHash(config), note: "Store initialised.", detail: { budgets: config.budgets, approvers: config.approvers } });
    });
    return store;
  }

  static open(root: string, options: StoreOptions = {}): GtmStore {
    const store = new GtmStore(root, options);
    if (!existsSync(store.path("config.json")) || !existsSync(store.path("events.jsonl"))) {
      throw new Error(`No go-to-market store at ${store.root}. Run "gtm init" first.`);
    }
    return store;
  }

  // --- files -----------------------------------------------------------------

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private recordPath(kind: Kind, id: string): string {
    return this.path("records", kind, `${id}.json`);
  }

  private lock(): () => void {
    const lockPath = this.path(".lock");
    const started = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx"));
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // already gone
          }
        };
      } catch {
        // A writer that died leaves its lock behind; one older than 30 s is stale.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
        } catch {
          // released between the two calls
        }
        if (Date.now() - started > 10_000) throw new Error(`The store at ${this.root} is locked by another writer.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  /** Run writes as one transaction: all of them land, or none do. */
  mutate<T>(fn: () => T): T {
    if (this.tx) return fn();
    const release = this.lock();
    const meta = JSON.parse(readFileSync(this.path("meta.json"), "utf8")) as { counters: Record<string, number> };
    this.tx = { records: new Map(), events: [], counters: { ...meta.counters } };
    try {
      const result = fn();
      this.commit(this.tx);
      return result;
    } finally {
      this.tx = undefined;
      release();
    }
  }

  private commit(tx: Tx): void {
    if (tx.events.length === 0) return;
    let previous: { seq: number; eventHash: string } | undefined = this.events().at(-1);
    const lines: string[] = [];
    for (const event of tx.events) {
      const chained = chainEvent(event, previous);
      lines.push(JSON.stringify(chained));
      previous = chained;
    }
    for (const record of tx.records.values()) {
      mkdirSync(this.path("records", record.kind), { recursive: true });
      writeFileSync(this.recordPath(record.kind, record.id), json(record));
    }
    if (tx.config) writeFileSync(this.path("config.json"), json(tx.config));
    writeFileSync(this.path("meta.json"), json({ counters: tx.counters }));
    appendFileSync(this.path("events.jsonl"), `${lines.join("\n")}\n`);
  }

  private log(event: GtmEvent): void {
    this.tx!.events.push(event);
  }

  // --- reading ---------------------------------------------------------------

  events(): GtmEventRecord[] {
    const raw = readFileSync(this.path("events.jsonl"), "utf8").trim();
    return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as GtmEventRecord);
  }

  head(): { length: number; hash: string } {
    const events = this.events();
    return { length: events.length, hash: events.at(-1)?.eventHash ?? "" };
  }

  get<K extends Kind = Kind>(id: string): GtmRecord<K> | undefined {
    const pending = this.tx?.records.get(id);
    if (pending) return pending as GtmRecord<K>;
    const kind = kindOfId(id);
    if (!kind) return undefined;
    const file = this.recordPath(kind, id);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GtmRecord<K>) : undefined;
  }

  need<K extends Kind = Kind>(id: string): GtmRecord<K> {
    const record = this.get<K>(id);
    if (!record) throw new Error(`No such record: ${id}`);
    return record;
  }

  list<K extends Kind>(kind: K, filter: { status?: string } = {}): GtmRecord<K>[] {
    const byId = new Map<string, GtmRecord>();
    const dir = this.path("records", kind);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as GtmRecord;
        byId.set(record.id, record);
      }
    }
    for (const record of this.tx?.records.values() ?? []) if (record.kind === kind) byId.set(record.id, record);
    return [...byId.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((a, b) => a.id.localeCompare(b.id)) as GtmRecord<K>[];
  }

  all(): GtmRecord[] {
    return KIND_NAMES.flatMap((kind) => this.list(kind) as GtmRecord[]);
  }

  /** The configuration, refused if config.json was changed by anything but this store. */
  config(): GtmConfig {
    if (this.tx?.config) return this.tx.config;
    const config = validate(configSchema, JSON.parse(readFileSync(this.path("config.json"), "utf8")), "config.json");
    let recorded: string | undefined;
    for (const { event } of this.events()) if (event.configHash !== undefined) recorded = event.configHash;
    if (recorded !== contentHash(config)) {
      throw new ConfigError('config.json does not match the log: it was changed outside the store. Budgets and approvers change only through "gtm budget set".');
    }
    return config;
  }

  // --- lookup before writing ---------------------------------------------------

  /** The stored record a new one of this kind would duplicate, if any. */
  findDuplicate<K extends Kind>(kind: K, data: DataOf<K>): GtmRecord<K> | undefined {
    const keys = (KINDS[kind] as { keys?: (d: unknown) => string[] }).keys?.(data) ?? [];
    if (keys.length === 0) return undefined;
    return this.list(kind).find((record) => record.keys.some((key) => keys.includes(key)));
  }

  /** Everything on file about an organisation, by name or by web address. */
  findByOrganisation(nameOrUrl: string): GtmRecord[] {
    const wanted = [`org:${orgKey(nameOrUrl)}`, ...(domainOf(nameOrUrl) ? [`domain:${domainOf(nameOrUrl)}`] : [])];
    const name = orgKey(nameOrUrl);
    return this.all().filter((record) => {
      if (record.keys.some((key) => wanted.some((w) => key === w || key.startsWith(`${w}:`)))) return true;
      const organisation = (record.data as Data).organisation;
      return typeof organisation === "string" && orgKey(organisation) === name;
    });
  }

  /** The stored question matching this text, with every visibility test of it. */
  findByQuery(query: string): GtmRecord[] {
    const key = textKey(query);
    return [
      ...this.list("search-query").filter((r) => textKey(r.data.text) === key),
      ...this.list("visibility-test").filter((r) => textKey(r.data.query) === key),
    ];
  }

  /** Records whose own words contain every word of the topic, best matches first. */
  findByTopic(topic: string, limit = 25): GtmRecord[] {
    const words = textKey(topic).split(" ").filter((w) => w.length > 2);
    if (words.length === 0) return [];
    const scored: { record: GtmRecord; score: number }[] = [];
    for (const record of this.all()) {
      const haystack = textKey((KINDS[record.kind] as { words: (d: unknown) => string[] }).words(record.data).join(" "));
      const score = words.filter((w) => haystack.includes(w)).length;
      if (score === words.length || score >= 2) scored.push({ record, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, limit).map((s) => s.record);
  }

  isSuppressed(organisation: string, website?: string): boolean {
    const keys = [`org:${orgKey(organisation)}`, ...(domainOf(website) ? [`domain:${domainOf(website)}`] : [])];
    return this.list("suppression").some((s) => s.keys.some((key) => keys.includes(key)));
  }

  /** Is there a granted approval for this action that covers this record? */
  hasApproval(recordId: string, action: ApprovalAction): boolean {
    return this.list("approval").some(
      (a) => a.status === "granted" && a.data.action === action && (a.data.subjectId === recordId || a.data.relatedIds.includes(recordId)),
    );
  }

  // --- validation ----------------------------------------------------------------

  private keysOf(kind: Kind, data: Data): string[] {
    return (KINDS[kind] as { keys?: (d: unknown) => string[] }).keys?.(data) ?? [];
  }

  private checked(record: GtmRecord, before: GtmRecord | undefined, actor: Actor): GtmRecord {
    const def = KINDS[record.kind];
    const what = `${record.kind} ${record.id}`;
    validate(def.schema as never, record.data, what);
    const issues: Issue[] = [];
    record.sources.forEach((source, index) => sourceSchema.check(source, `sources[${index}]`, issues));
    if (record.sources.length < def.minSources) {
      issues.push({ path: "sources", message: `needs at least ${def.minSources} dated source: every fact names where it was read and on what day` });
    }
    // Every id a record points at must be on file.
    const walk = (value: Data, path: string): void => {
      for (const [field, inner] of Object.entries(value)) {
        const at = path ? `${path}.${field}` : field;
        if (/Ids?$/.test(field) || field === "inputs") {
          for (const id of Array.isArray(inner) ? inner : [inner]) {
            if (typeof id === "string" && /^[A-Z]{3}-\d{4,}$/.test(id) && !this.get(id)) issues.push({ path: at, message: `${id} is not on file` });
          }
        } else if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
          walk(inner as Data, at);
        }
      }
    };
    walk(record.data as Data, "");
    if (issues.length > 0) throw new SchemaError(what, issues);
    this.kindRules(record, before, actor);
    record.keys = this.keysOf(record.kind, record.data as Data);
    return record;
  }

  private checkDraft(what: string, texts: string[], figures: DeclaredFigure[]): void {
    const problems = draftProblems(texts, figures, this.numbers());
    if (problems.length > 0) throw new GateError(`${what} cannot be stored: ${problems.join("; ")}.`);
  }

  private checkRoutes(what: string, routes: { type: string; url: string }[]): void {
    for (const route of routes) {
      if (/linkedin\.com/i.test(route.url)) throw new GateError(`${what}: LinkedIn is not a contact route the engine keeps (${route.url}).`);
      const mailbox = /^(?:mailto:)?([^@\s/]+)@[^@\s]+$/i.exec(route.url)?.[1]?.toLowerCase();
      if (mailbox !== undefined && !ROLE_MAILBOXES.includes(mailbox)) {
        throw new GateError(`${what}: "${route.url}" looks like a person's address. Only an organisation's public business routes are kept (${ROLE_MAILBOXES.join(", ")}).`);
      }
      if (route.type === "role-mailbox" && mailbox === undefined) throw new GateError(`${what}: a role-mailbox route must be an address such as hello@…`);
    }
  }

  /** Rules that depend on the kind, beyond its shape. */
  private kindRules(record: GtmRecord, before: GtmRecord | undefined, actor: Actor): void {
    const data = record.data as Data;
    const prior = before?.data as Data | undefined;
    const what = `${record.kind} ${record.id}`;
    switch (record.kind) {
      case "prospect": {
        const p = record.data as DataOf<"prospect">;
        this.checkRoutes(what, p.contactRoutes);
        if (p.publicSignals.some((s) => /linkedin\.com/i.test(s.url))) throw new GateError(`${what}: LinkedIn pages are not read or kept.`);
        if (prior?.optOut === true && p.optOut === false) throw new GateError(`${what}: an opt-out is never reversed by the engine.`);
        if (isAgent(actor) && !before && p.contactStatus !== "not-contacted") throw new GateError(`${what}: a new prospect is "not-contacted"; only a person's report changes that.`);
        break;
      }
      case "outreach-draft": {
        const d = record.data as DataOf<"outreach-draft">;
        const prospect = this.need<"prospect">(d.prospectId);
        if (record.status === "drafted" || record.status === "approved") {
          if (prospect.data.optOut) throw new GateError(`${what}: ${prospect.id} (${prospect.data.organisation}) has opted out. Nothing is drafted to it.`);
          if (this.isSuppressed(prospect.data.organisation, prospect.data.website)) {
            throw new GateError(`${what}: ${prospect.data.organisation} is on the suppression list. Nothing is drafted to it.`);
          }
        }
        if (!before && prospect.status !== "qualified") {
          throw new GateError(`${what}: outreach is drafted only to a qualified prospect; ${prospect.id} is "${prospect.status}".`);
        }
        this.checkRoutes(what, [d.route]);
        if (!before || prior?.body !== d.body || prior?.subject !== d.subject) this.checkDraft(what, [d.subject, d.body], d.figures);
        break;
      }
      case "content-item": {
        const c = record.data as DataOf<"content-item">;
        if (c.draft && contentHash(c.draft) !== contentHash(prior?.draft ?? null)) {
          this.checkDraft(what, [c.draft.body], c.draft.figures);
          // The store, not the agent, records who wrote the draft now on file.
          if (isAgent(actor)) data.draftedBy = actor;
        } else if (isAgent(actor) && c.draftedBy !== prior?.draftedBy) {
          throw new GateError(`${what}: "draftedBy" is set by the store, not by an agent.`);
        }
        break;
      }
      case "community-opportunity":
      case "partnership": {
        const draft = data.draft as { body: string; figures: DeclaredFigure[] } | undefined;
        if (draft && contentHash(draft) !== contentHash(prior?.draft ?? null)) this.checkDraft(what, [draft.body], draft.figures);
        break;
      }
      case "experiment": {
        const e = record.data as DataOf<"experiment">;
        if (e.result && e.result.outcome !== "inconclusive" && e.result.observationIds.length === 0) {
          throw new GateError(`${what}: a result other than "inconclusive" must rest on stored metric observations.`);
        }
        break;
      }
      default:
        break;
    }
  }

  private save(record: GtmRecord, event: Omit<GtmEvent, "recordHash" | "recordId" | "kind">): void {
    this.tx!.records.set(record.id, record);
    this.log({ ...event, recordId: record.id, kind: record.kind, recordHash: contentHash(record) });
  }

  private nextId(kind: Kind): string {
    const prefix = KINDS[kind].prefix;
    const next = (this.tx!.counters[prefix] ?? 0) + 1;
    this.tx!.counters[prefix] = next;
    return `${prefix}-${String(next).padStart(4, "0")}`;
  }

  // --- writing ---------------------------------------------------------------

  private insert<K extends Kind>(actor: Actor, kind: K, data: DataOf<K>, options: WriteOptions, internal: Internal): GtmRecord<K> {
    if (!internal.system) assertCan(actor, { op: "create", kind });
    const at = this.now();
    const def = KINDS[kind];
    const record = {
      id: this.nextId(kind),
      kind,
      status: def.initial,
      keys: [],
      createdAt: at,
      updatedAt: at,
      createdBy: actor,
      updatedBy: actor,
      sources: options.sources ?? [],
      data,
      history: [{ at, from: null, to: def.initial, by: actor, note: options.note ?? "Created." }],
    } as GtmRecord;
    this.checked(record, undefined, actor);
    this.save(record, { at, actor, type: "create", to: def.initial, note: options.note });
    if (kind === "outreach-draft") this.setContactStatus((data as Data).prospectId as string, "draft-awaiting-approval");
    return record as GtmRecord<K>;
  }

  /** Add a record. Throws DuplicateRecordError when it is already on file. */
  create<K extends Kind>(actor: Actor, kind: K, data: DataOf<K>, options: WriteOptions = {}): GtmRecord<K> {
    return this.mutate(() => {
      validate(KINDS[kind].schema as never, data, `the new ${kind}`);
      const prior = this.findDuplicate(kind, data);
      if (prior) throw new DuplicateRecordError(kind, prior.id);
      return this.insert(actor, kind, data, options, {});
    });
  }

  /**
   * Add a record, or update the one it duplicates: the same organisation or
   * question is one record, however many times it is found.
   */
  upsert<K extends Kind>(actor: Actor, kind: K, data: DataOf<K>, options: WriteOptions = {}): WriteOutcome<K> {
    return this.mutate(() => {
      validate(KINDS[kind].schema as never, data, `the new ${kind}`);
      const prior = this.findDuplicate(kind, data);
      if (!prior) return { record: this.insert(actor, kind, data, options, {}), outcome: "created" as const };
      const patch: Data = {};
      for (const [field, value] of Object.entries(data as Data)) {
        if (contentHash(value) === contentHash((prior.data as Data)[field])) continue;
        // A re-found record keeps what only people and the pipeline may change.
        if (!can(actor, { op: "update", kind, field })) continue;
        patch[field] = value;
      }
      const sources = mergeSources(prior.sources, options.sources ?? []);
      if (Object.keys(patch).length === 0 && sources.length === prior.sources.length) return { record: prior, outcome: "unchanged" as const };
      return { record: this.update(actor, prior.id, patch as Partial<DataOf<K>>, { sources: options.sources, note: options.note ?? "Found again; updated." }), outcome: "updated" as const };
    });
  }

  /** Edit fields of a record. The status does not change here. */
  update<K extends Kind>(actor: Actor, id: string, patch: Partial<DataOf<K>>, options: WriteOptions = {}, internal: Internal = {}): GtmRecord<K> {
    return this.mutate(() => {
      const before = this.need(id);
      if (!internal.system) {
        for (const field of Object.keys(patch)) assertCan(actor, { op: "update", kind: before.kind, field });
        if (!isHuman(actor) && LOCKED[before.kind]?.includes(before.status)) {
          throw new GateError(`${id} is "${before.status}": what was approved or reported stays as it is. Only a person may edit it.`);
        }
      }
      const at = this.now();
      const data = { ...(before.data as Data), ...(patch as Data) };
      for (const [field, value] of Object.entries(patch as Data)) if (value === null) delete data[field];
      const record = { ...before, data, updatedAt: at, updatedBy: actor, sources: mergeSources(before.sources, options.sources ?? []) } as GtmRecord;
      this.checked(record, before, actor);
      this.save(record, { at, actor, type: "update", note: options.note, detail: { fields: Object.keys(patch) } });
      if (before.kind === "prospect" && (before.data as Data).optOut !== true && data.optOut === true) this.afterOptOut(record as GtmRecord<"prospect">, actor);
      return record as GtmRecord<K>;
    });
  }

  /** Move a record along an edge of its pipeline. */
  transition<K extends Kind>(
    actor: Actor,
    id: string,
    to: string,
    options: WriteOptions & { patch?: Partial<DataOf<K>> } = {},
    internal: Internal = {},
  ): GtmRecord<K> {
    return this.mutate(() => {
      const before = this.need(id);
      const from = before.status;
      const edge = findEdge(before.kind, from, to);
      if (!edge) throw new GateError(`A ${before.kind} cannot move from "${from}" to "${to}".`);
      if (edge.fact && !internal.fact) {
        throw new GateError(`"${to}" is something that happened in the world. It is recorded only by a person, with the evidence: gtm record --record ${id} --to ${to} --evidence … --reported-by …`);
      }
      if (edge.onApproval && !internal.approval) {
        throw new GateError(`${id} moves to "${to}" only when a person approves it: gtm approve --record ${id} --action ${edge.onApproval} --approved-by …`);
      }
      if (!edge.fact && !edge.onApproval && !internal.system) assertCan(actor, { op: "move", kind: before.kind, from, to });
      if (edge.needsApproval && !this.hasApproval(id, edge.needsApproval)) {
        throw new GateError(`${id} cannot move to "${to}": no approval for "${edge.needsApproval}" covers it.`);
      }

      const patch = (options.patch ?? {}) as Data;
      if (isAgent(actor)) {
        const extra = edgeFields(before.kind, from, to);
        for (const field of Object.keys(patch)) {
          if (!extra.includes(field)) assertCan(actor, { op: "update", kind: before.kind, field });
        }
      }
      const at = this.now();
      const data: Data = { ...(before.data as Data), ...patch };
      this.edgeRules(before, edge, data, actor);
      const record = {
        ...before,
        status: to,
        data,
        updatedAt: at,
        updatedBy: actor,
        sources: mergeSources(before.sources, options.sources ?? []),
        history: [...before.history, { at, from, to, by: actor, note: options.note ?? "" }],
      } as GtmRecord;
      this.checked(record, before, actor);
      this.save(record, { at, actor, type: internal.fact ? "fact" : internal.approval ? "approval" : "transition", from, to, note: options.note });
      return record as GtmRecord<K>;
    });
  }

  /** What an edge needs to be true, and what the store itself writes on it. */
  private edgeRules(before: GtmRecord, edge: Edge, data: Data, actor: Actor): void {
    const id = before.id;
    const move = `${edge.from}>${edge.to}`;
    const refuse: (why: string) => never = (why) => {
      throw new GateError(`${id} cannot move to "${edge.to}": ${why}`);
    };
    switch (before.kind) {
      case "prospect": {
        const p = data as DataOf<"prospect">;
        const barred = p.optOut || this.isSuppressed(p.organisation, p.website);
        if (move === "researched>qualified") {
          if (!p.qualification) refuse("it has no qualification score with reasons.");
          if (p.lawfulBasis.basis === "not-assessed") refuse("its lawful basis has not been assessed.");
          if (barred) refuse("the organisation has opted out or is on the suppression list.");
        }
        if (edge.to === "lost" && !p.lostReason && !edge.fact) refuse("it needs the reason (lostReason).");
        if (["contact-approved", "contacted"].includes(edge.to) && barred) refuse("the organisation has opted out or is on the suppression list.");
        break;
      }
      case "outreach-draft": {
        const prospect = this.need<"prospect">((data as DataOf<"outreach-draft">).prospectId);
        if (["approved", "sent"].includes(edge.to) && (prospect.data.optOut || this.isSuppressed(prospect.data.organisation, prospect.data.website))) {
          refuse(`${prospect.data.organisation} has opted out or is on the suppression list.`);
        }
        break;
      }
      case "content-item": {
        const c = data as DataOf<"content-item">;
        if (move === "research>brief" && !c.researchNotes) refuse("it has no research notes.");
        if (move === "brief>draft" && !c.brief) refuse("it has no brief.");
        if (move === "draft>fact-check") {
          if (!c.draft) refuse("it has no draft.");
          data.draftedBy = c.draftedBy ?? actor;
          delete data.factCheck;
          delete data.review;
        }
        if (edge.from === "fact-check" && edge.to !== "dropped") {
          const wrote = c.draftedBy === actor || before.history.some((h) => h.to === "fact-check" && h.by === actor);
          if (wrote) refuse(`${actor} drafted it; the agent that drafts an item is never the one that fact-checks it.`);
          const wanted = edge.to === "review" ? "pass" : "fail";
          if (c.factCheck?.verdict !== wanted) refuse(`the fact-check verdict must be "${wanted}".`);
          if (wanted === "fail" && c.factCheck.issues.length === 0) refuse("a failed check lists what failed.");
          data.factCheck = { ...c.factCheck, by: actor };
        }
        if (move === "review>draft" && c.review?.verdict !== "revise") refuse('the review verdict must be "revise".');
        if (move === "review>approve" && c.review?.verdict !== "pass") refuse("it has not passed review.");
        if (edge.to === "measured" && !(c.performance && c.performance.observationIds.length > 0)) refuse("it needs the stored metric observations that measure it.");
        break;
      }
      case "community-opportunity":
      case "partnership":
        if (edge.to === "drafted" && !data.draft) refuse("it has no draft.");
        break;
      case "experiment": {
        const e = data as DataOf<"experiment">;
        if (edge.to === "evaluated" && !e.result) refuse("it has no result.");
        if (edge.to === "scaled" && e.decision?.choice !== "scale") refuse('the decision must be "scale", with its reason.');
        if (edge.to === "stopped" && edge.from === "evaluated" && e.decision?.choice !== "stop") refuse('the decision must be "stop", with its reason.');
        break;
      }
      default:
        break;
    }
  }

  private setContactStatus(prospectId: string, status: DataOf<"prospect">["contactStatus"]): void {
    const prospect = this.need<"prospect">(prospectId);
    if (prospect.data.contactStatus === status || prospect.data.contactStatus === "do-not-contact") return;
    this.update("orchestrator", prospectId, { contactStatus: status }, { note: `Contact status: ${status}.` }, { system: true });
  }

  /** An opt-out withdraws every open draft to that organisation, at once. */
  private afterOptOut(prospect: GtmRecord<"prospect">, actor: Actor): void {
    if (prospect.data.contactStatus !== "do-not-contact") {
      this.update("orchestrator", prospect.id, { contactStatus: "do-not-contact" }, { note: "Opted out." }, { system: true });
    }
    for (const draft of this.list("outreach-draft")) {
      if (draft.data.prospectId === prospect.id && (draft.status === "drafted" || draft.status === "approved")) {
        this.transition(actor, draft.id, "withdrawn", { note: `${prospect.data.organisation} opted out.` }, { system: true });
      }
    }
  }

  // --- the commands only a person runs -------------------------------------------

  private person(name: string, doing: string): Actor {
    const approvers = this.config().approvers;
    const match = approvers.find((a) => a.toLowerCase() === name.trim().toLowerCase());
    if (!match) throw new GateError(`"${name}" is not a person who may ${doing}. On file: ${approvers.join(", ")}.`);
    return `human:${match}`;
  }

  /**
   * Record a person's approval and make the move it unlocks. There is no other
   * way to create an approval: no agent's grant includes the kind, and the
   * general write path refuses it for everyone.
   */
  approve(input: { recordId: string; action: ApprovalAction; approvedBy: string; note?: string }): { approval: GtmRecord<"approval">; record: GtmRecord } {
    return this.mutate(() => {
      const actor = this.person(input.approvedBy, "approve");
      const record = this.need(input.recordId);
      const from = APPROVABLE[input.action][record.kind];
      if (!from) throw new GateError(`"${input.action}" is not an approval for a ${record.kind}.`);
      if (!from.includes(record.status)) {
        throw new GateError(`${record.id} is "${record.status}". "${input.action}" is approved from: ${from.join(", ")}.`);
      }
      const relatedIds = record.kind === "outreach-draft" ? [(record.data as DataOf<"outreach-draft">).prospectId] : [];
      const approval = this.insert(
        actor,
        "approval",
        { subjectId: record.id, relatedIds, action: input.action, approvedBy: actor.slice("human:".length), approvedOn: today(this.now()), ...(input.note ? { note: input.note } : {}) },
        { note: `Approved by ${actor.slice("human:".length)}.` },
        { system: true },
      );
      const note = `Approved (${approval.id}).`;
      let moved = record;
      const onApproval = (kind: Kind, status: string) => findEdgeOn(kind, status, input.action);
      const own = onApproval(record.kind, record.status);
      if (own) moved = this.transition(actor, record.id, own.to, { note }, { approval: true });
      for (const relatedId of relatedIds) {
        const related = this.need(relatedId);
        const edgeFor = onApproval(related.kind, related.status);
        if (edgeFor) this.transition(actor, relatedId, edgeFor.to, { note }, { approval: true });
      }
      const prospectId = record.kind === "prospect" ? record.id : relatedIds[0];
      if (prospectId && input.action === "contact") this.setContactStatus(prospectId, "contact-approved");
      return { approval, record: this.need(moved.id) };
    });
  }

  /**
   * Record something that happened in the world, as a person reports it, with
   * the evidence. The engine never infers "contacted", "engaged", "customer",
   * "published", "distributed", "posted" or "submitted".
   */
  recordFact(input: { recordId: string; to: string; evidence: string; reportedBy: string; occurredOn?: string }): { interaction: GtmRecord<"interaction">; record: GtmRecord } {
    return this.mutate(() => {
      const actor = this.person(input.reportedBy, "report a fact");
      const before = this.need(input.recordId);
      const edge = findEdge(before.kind, before.status, input.to);
      if (!edge) throw new GateError(`A ${before.kind} cannot move from "${before.status}" to "${input.to}".`);
      if (!edge.fact) throw new GateError(`"${input.to}" is not a reported fact; it is a move the pipeline makes.`);
      if (input.evidence.trim().length < 8) throw new GateError("A reported fact names its evidence: a link, a message reference, an invoice number.");
      const interaction = this.insert(
        actor,
        "interaction",
        { subjectId: before.id, type: input.to, occurredOn: input.occurredOn ?? today(this.now()), evidence: input.evidence.trim(), reportedBy: actor.slice("human:".length) },
        { note: `Reported by ${actor.slice("human:".length)}.` },
        { system: true },
      );
      const patch: Data = {};
      if (before.kind === "content-item" && input.to === "published" && /^https?:\/\//.test(input.evidence.trim())) patch.publishedUrl = input.evidence.trim();
      const record = this.transition(actor, before.id, input.to, { patch, note: `Reported (${interaction.id}): ${input.evidence.trim()}` }, { fact: true });
      if (before.kind === "prospect") {
        if (input.to === "contacted") this.setContactStatus(before.id, "contacted");
        if (input.to === "engaged") this.setContactStatus(before.id, "replied");
      }
      if (before.kind === "outreach-draft" && input.to === "sent") {
        const prospect = this.need((before.data as DataOf<"outreach-draft">).prospectId);
        if (prospect.status === "contact-approved") {
          this.transition(actor, prospect.id, "contacted", { note: `Reported (${interaction.id}): ${before.id} was sent.` }, { fact: true });
          this.setContactStatus(prospect.id, "contacted");
        }
      }
      return { interaction, record: this.need(record.id) };
    });
  }

  /** Put an organisation on the suppression list. There is no command that takes one off. */
  suppress(input: { organisation: string; domain?: string; reason: string; reportedBy: string }): GtmRecord<"suppression"> {
    return this.mutate(() => {
      const actor = this.person(input.reportedBy, "suppress an organisation");
      const data: DataOf<"suppression"> = {
        organisation: input.organisation,
        ...(input.domain ? { domain: input.domain.toLowerCase() } : {}),
        reason: input.reason,
        requestedOn: today(this.now()),
        reportedBy: actor.slice("human:".length),
      };
      const entry = this.findDuplicate("suppression", data) ?? this.insert(actor, "suppression", data, { note: "Suppressed." }, { system: true });
      for (const prospect of this.list("prospect")) {
        if (!prospect.data.optOut && this.isSuppressed(prospect.data.organisation, prospect.data.website)) {
          this.update(actor, prospect.id, { optOut: true }, { note: `Suppressed (${entry.id}): ${input.reason}` });
        }
      }
      return entry;
    });
  }

  /**
   * Change the configuration (budgets, approvers). A person's act, logged with
   * who and when; config.json edited by hand no longer matches the log and the
   * store refuses to hand out work until it does.
   */
  setConfig(input: { changedBy: string; change: (config: GtmConfig) => GtmConfig; note: string }): GtmConfig {
    return this.mutate(() => {
      const actor = this.person(input.changedBy, "change the budget");
      const before = this.config();
      const after = validate(configSchema, input.change(structuredClone(before)), "The configuration");
      const problems = configProblems(after);
      if (problems.length > 0) throw new ConfigError(`That change is refused: ${problems.join("; ")}.`);
      if (contentHash(before) === contentHash(after)) return before;
      this.tx!.config = after;
      this.log({ at: this.now(), actor, type: "config", configHash: contentHash(after), note: input.note, detail: { before: before.budgets, after: after.budgets, approvers: after.approvers } });
      return after;
    });
  }

  /** A step of the orchestrator, written to the same chained log. */
  logStep(step: string, detail: Record<string, unknown> = {}): void {
    this.mutate(() => this.log({ at: this.now(), actor: "orchestrator", type: "orchestrator", note: step, detail }));
  }

  // --- verification ------------------------------------------------------------

  /**
   * Check the whole store: the chain end to end, every record file against the
   * hash logged when it was last written, and config.json against the log. An
   * edited event, a reordered or deleted one, a hand-edited or added record
   * file, or a changed budget each fail it.
   */
  verify(): VerifyResult {
    const events = this.events();
    const problems: string[] = [];
    const chain = verifyChain(events);
    if (!chain.ok) problems.push(`The event log is broken at event ${chain.seq}: ${chain.reason}`);

    const lastHash = new Map<string, string>();
    let configHash: string | undefined;
    for (const { event } of events) {
      if (event.recordId && event.recordHash) lastHash.set(event.recordId, event.recordHash);
      if (event.configHash) configHash = event.configHash;
    }
    let records: GtmRecord[] = [];
    try {
      records = this.all();
    } catch (error) {
      problems.push(`A record file cannot be read: ${(error as Error).message}`);
    }
    for (const record of records) {
      const logged = lastHash.get(record.id);
      if (!logged) problems.push(`${record.id} has a file but no entry in the log.`);
      else if (logged !== contentHash(record)) problems.push(`${record.id} does not match the log: its file was changed outside the store.`);
      lastHash.delete(record.id);
    }
    for (const missing of lastHash.keys()) problems.push(`${missing} is in the log but its file is gone.`);
    try {
      const config = JSON.parse(readFileSync(this.path("config.json"), "utf8")) as unknown;
      if (configHash !== contentHash(config)) problems.push("config.json does not match the log: it was changed outside the store.");
    } catch {
      problems.push("config.json cannot be read.");
    }
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, events: events.length, records: records.length, head: events.at(-1)?.eventHash ?? "" };
  }
}

function findEdgeOn(kind: Kind, from: string, action: ApprovalAction): Edge | undefined {
  // The move the approve command makes for this action, from this status.
  for (const to of KINDS[kind].statuses) {
    const edge = findEdge(kind, from, to);
    if (edge?.onApproval === action) return edge;
  }
  return undefined;
}
