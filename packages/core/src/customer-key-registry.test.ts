import { describe, expect, it } from "vitest";
import {
  CUSTOMER_KEY_GENESIS_HASH,
  CUSTOMER_KEY_SCHEMA,
  buildNextCustomerKeyEntry,
  checkRegisteredKeyForStatement,
  currentCustomerKey,
  customerKeyEntryHash,
  customerKeyHistory,
  customerKeyRegistryPath,
  isCustomerId,
  parseCustomerKeyRegistry,
  readCustomerKeyRegistry,
  registryCustomers,
  serializeCustomerKeyEntry,
  verifyCustomerKeyRegistry,
  type CustomerKeyAction,
  type CustomerKeyEntry,
} from "./customer-key-registry.js";
import {
  STATEMENT_SCHEMA,
  STATEMENT_SEAL_RULE,
  checkStatementForBilling,
  describeBillSpool,
  signStatementSeal,
  statementKeyFromPrivate,
  statementSeal,
  type BillSpool,
} from "./manual-billing-checks.js";
import { LEDGER_GENESIS_HASH, chainLedgerRecord, recomputeInvoice, verifyLedgerChain, type BillableEvent, type LedgerRecord } from "./savings-ledger.js";
import { buildStripeInvoicePlan } from "./stripe-billing.js";

const PERIOD = "2026-10";
const ACME = "cus_ACME";
const OTHER = "cus_OTHER";

// Fixed test keys: the secret keys of RFC 8032 section 7.1, tests 1, 2 and 3.
// Published test vectors, not anyone's key. The first two are the ones
// manual-billing-checks.test.ts uses for the customer and the operator.
const hexToBase64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
const CUSTOMER = statementKeyFromPrivate(hexToBase64("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
const OPERATOR = statementKeyFromPrivate(hexToBase64("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));
const NEW_KEY = statementKeyFromPrivate(hexToBase64("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"));

const REGISTERED_AT = "2026-10-20T09:00:00.000Z";
const REPLACED_AT = "2026-11-02T12:00:00.000Z";
const WRITTEN_AT = "2026-11-03T08:30:00.000Z";
const CHANNEL = "Signed order form, then read back on a call with their CTO";

type Step = { action: CustomerKeyAction; customer?: string; fingerprint?: string; channel?: string; at?: string; operatorKeyFingerprint?: string };

/** Add one entry the way the command does, or throw with the refusal. */
function add(entries: readonly CustomerKeyEntry[], step: Step): CustomerKeyEntry[] {
  const next = buildNextCustomerKeyEntry({
    entries,
    action: step.action,
    customer: step.customer ?? ACME,
    ...(step.fingerprint === undefined ? {} : { fingerprint: step.fingerprint }),
    channel: step.channel ?? CHANNEL,
    now: new Date(step.at ?? REGISTERED_AT),
    ...(step.operatorKeyFingerprint === undefined ? {} : { operatorKeyFingerprint: step.operatorKeyFingerprint }),
  });
  if (!next.ok) throw new Error(next.reason);
  return [...entries, next.entry];
}

const refusal = (entries: readonly CustomerKeyEntry[], step: Step): string => {
  try {
    add(entries, step);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

/** Three entries: ACME registered, OTHER registered, ACME replaced. */
function registry(): CustomerKeyEntry[] {
  let entries: CustomerKeyEntry[] = [];
  entries = add(entries, { action: "register", fingerprint: CUSTOMER.fingerprint, at: REGISTERED_AT });
  entries = add(entries, { action: "register", customer: OTHER, fingerprint: OPERATOR.fingerprint, at: "2026-10-21T09:00:00.000Z" });
  entries = add(entries, { action: "replace", fingerprint: NEW_KEY.fingerprint, at: REPLACED_AT, channel: "Call to the named contact on the number in the order form" });
  return entries;
}

const textOf = (entries: readonly CustomerKeyEntry[]): string => entries.map(serializeCustomerKeyEntry).join("");

// --- A real signed statement, built the way manual-billing-checks.test.ts builds one. ---

let counter = 0;
const saved = (savedUsd: number, invoicePeriod = PERIOD): BillableEvent => {
  counter += 1;
  return {
    schemaVersion: 1,
    requestId: `r${counter}`,
    applicationId: "app",
    invoicePeriod,
    timestamp: `${invoicePeriod}-15T10:00:00.000Z`,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
    status: "succeeded",
  };
};

function chain(events: BillableEvent[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const event of events) records.push(chainLedgerRecord(event, records[records.length - 1]));
  return records;
}

type Ledger = Record<string, LedgerRecord[]>;

function ledger(): Ledger {
  counter = 0;
  return {
    "app-anthropic.jsonl": chain([saved(1, "2026-09"), saved(4), saved(3.0947), saved(0.5)]),
    "app-openai.jsonl": chain([saved(1.5), saved(0.5)]),
  };
}

/** What the bill itself computes from the files in hand: scripts/mesh-bill.ts's sequence. */
function billOf(files: Ledger) {
  const spools: BillSpool[] = Object.entries(files).map(([name, records]) => describeBillSpool(name, records, PERIOD));
  const chainVerified = Object.values(files).every((records) => verifyLedgerChain(records).ok);
  const invoice = recomputeInvoice(Object.values(files).flatMap((records) => records.map((r) => r.event)), { period: PERIOD, feePercent: 1 });
  const plan = buildStripeInvoicePlan(invoice, chainVerified, { stripeCustomerId: ACME });
  return {
    spools,
    bill: {
      netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
      feeCents: plan.action === "bill" ? plan.amountCents : 0,
      feePercent: 1,
    },
  };
}

/** A sealed and signed statement shaped as `mesh statement` writes it, with the time it was written inside the seal. */
function statementOf(files: Ledger, generatedAt: string | undefined, signer = CUSTOMER): Record<string, unknown> {
  const { spools, bill } = billOf(files);
  const body: Record<string, unknown> = {
    schema: STATEMENT_SCHEMA,
    kind: "statement",
    ...(generatedAt === undefined ? {} : { generatedAt }),
    period: { id: PERIOD, timezone: "UTC", closed: true },
    currency: "USD",
    validForBilling: true,
    ledger: {
      chainVerified: true,
      spools: spools.map((spool) => ({
        records: spool.records,
        recordsInPeriod: spool.recordsInPeriod,
        chainVerified: true,
        ...(spool.headHash === undefined ? {} : { headSeq: spool.records - 1, headHash: spool.headHash }),
      })),
    },
    totals: { netVerifiedSavingsUsd: bill.netVerifiedSavingsUsd },
    fee: { ratePercent: 1, amountCents: bill.feeCents, amountUsd: bill.feeCents / 100 },
  };
  const sealed = { ...body, sha256Of: STATEMENT_SEAL_RULE, sha256: statementSeal(body) };
  return { ...sealed, signature: signStatementSeal(sealed.sha256, signer.privateKey) };
}

const reasonOf = (result: { ok: boolean; reason?: string }): string => {
  if (result.ok || result.reason === undefined) throw new Error("expected a refusal");
  return result.reason;
};

describe("the registry file's path", () => {
  it("is --registry, else the environment variable, else ~/.config/mesh/customer-keys.jsonl", () => {
    expect(customerKeyRegistryPath({ home: "/home/op" })).toBe("/home/op/.config/mesh/customer-keys.jsonl");
    expect(customerKeyRegistryPath({ home: "/home/op", env: "/srv/keys.jsonl" })).toBe("/srv/keys.jsonl");
    expect(customerKeyRegistryPath({ home: "/home/op", env: "/srv/keys.jsonl", flag: "/tmp/r.jsonl" })).toBe("/tmp/r.jsonl");
    expect(customerKeyRegistryPath({ home: "/home/op", env: "  ", flag: "" })).toBe("/home/op/.config/mesh/customer-keys.jsonl");
  });
});

describe("building the chain", () => {
  it("writes the first entry onto the genesis hash, with every field of the format", () => {
    const [entry] = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    expect(entry).toEqual({
      schema: CUSTOMER_KEY_SCHEMA,
      seq: 0,
      prevHash: CUSTOMER_KEY_GENESIS_HASH,
      at: REGISTERED_AT,
      action: "register",
      customer: ACME,
      fingerprint: CUSTOMER.fingerprint,
      channel: CHANNEL,
      entryHash: customerKeyEntryHash(entry!),
    });
    expect(CUSTOMER_KEY_GENESIS_HASH).toBe(LEDGER_GENESIS_HASH);
    expect("replaces" in entry!).toBe(false);
  });

  it("chains each entry onto the one before it, and the whole registry verifies", () => {
    const entries = registry();
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(entries[1]!.prevHash).toBe(entries[0]!.entryHash);
    expect(entries[2]!.prevHash).toBe(entries[1]!.entryHash);
    expect(verifyCustomerKeyRegistry(entries)).toEqual({ ok: true, length: 3, headHash: entries[2]!.entryHash });
    expect(verifyCustomerKeyRegistry([])).toEqual({ ok: true, length: 0, headHash: CUSTOMER_KEY_GENESIS_HASH });
  });

  it("takes the entry's time from the clock it is given, never its own", () => {
    const [entry] = add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: "2031-01-02T03:04:05.678Z" });
    expect(entry!.at).toBe("2031-01-02T03:04:05.678Z");
  });

  it("hashes the entry's content: the hash does not depend on key order and covers every field", () => {
    const [entry] = registry();
    const reordered = Object.fromEntries(Object.entries(entry!).reverse()) as CustomerKeyEntry;
    expect(customerKeyEntryHash(reordered)).toBe(entry!.entryHash);
    for (const change of [{ seq: 5 }, { at: "2026-10-20T09:00:00.001Z" }, { customer: OTHER }, { channel: `${CHANNEL}.` }, { fingerprint: NEW_KEY.fingerprint }, { action: "replace" as const }]) {
      expect(customerKeyEntryHash({ ...entry!, ...change })).not.toBe(entry!.entryHash);
    }
  });

  it("round-trips through the file's text", () => {
    const entries = registry();
    const text = textOf(entries);
    expect(text.split("\n")).toHaveLength(4);
    expect(parseCustomerKeyRegistry(text)).toEqual({ ok: true, entries });
    expect(readCustomerKeyRegistry(text)).toEqual({ ok: true, entries, headHash: entries[2]!.entryHash });
    expect(parseCustomerKeyRegistry("")).toEqual({ ok: true, entries: [] });
  });
});

describe("a registry changed by hand", () => {
  const lines = (): string[] => textOf(registry()).trimEnd().split("\n");
  const read = (changed: string[]) => readCustomerKeyRegistry(`${changed.join("\n")}\n`);

  it("detects a hand-edited line: a fingerprint swapped in an entry", () => {
    const changed = lines();
    changed[0] = changed[0]!.replace(CUSTOMER.fingerprint, OPERATOR.fingerprint.replace(/^./, "0"));
    const result = read(changed);
    expect(result).toMatchObject({ ok: false, seq: 0 });
    expect(reasonOf(result)).toBe("the chain is broken at seq 0: entryHash does not match the entry's content: the line was edited.");
  });

  it("detects a hand-edited time: a registration moved earlier", () => {
    const changed = lines();
    changed[2] = changed[2]!.replace(REPLACED_AT, "2026-10-22T12:00:00.000Z");
    expect(reasonOf(read(changed))).toBe("the chain is broken at seq 2: entryHash does not match the entry's content: the line was edited.");
  });

  it("detects an edited line whose own hash was recomputed: the next entry no longer chains onto it", () => {
    const entries = registry();
    const forged = { ...entries[0]!, at: "2026-10-01T09:00:00.000Z" };
    forged.entryHash = customerKeyEntryHash(forged);
    const result = verifyCustomerKeyRegistry([forged, entries[1]!, entries[2]!]);
    expect(result).toEqual({ ok: false, seq: 1, reason: "prevHash does not match the entry before it." });
  });

  it("detects a deleted line", () => {
    const changed = lines();
    changed.splice(1, 1);
    const result = read(changed);
    expect(result).toMatchObject({ ok: false, seq: 2 });
    expect(reasonOf(result)).toBe("the chain is broken at seq 2: expected seq 1, found 2: an entry was removed, added or moved.");
    const first = lines();
    first.splice(0, 1);
    expect(read(first)).toMatchObject({ ok: false, seq: 1 });
  });

  it("detects a reordered line", () => {
    const changed = lines();
    [changed[1], changed[2]] = [changed[2]!, changed[1]!];
    const result = read(changed);
    expect(result).toMatchObject({ ok: false, seq: 2 });
    expect(reasonOf(result)).toContain("expected seq 1, found 2");
  });

  it("detects a line added by hand that the rules would not allow, even with correct hashes", () => {
    const entries = registry();
    // A second "register" for a customer who already has a key, hashed and chained correctly.
    const content: Omit<CustomerKeyEntry, "entryHash"> = {
      schema: CUSTOMER_KEY_SCHEMA,
      seq: 3,
      prevHash: entries[2]!.entryHash,
      at: "2026-11-05T00:00:00.000Z",
      action: "register",
      customer: ACME,
      fingerprint: CUSTOMER.fingerprint,
      channel: CHANNEL,
    };
    const result = verifyCustomerKeyRegistry([...entries, { ...content, entryHash: customerKeyEntryHash(content) }]);
    expect(result).toMatchObject({ ok: false, seq: 3 });
    expect(reasonOf(result)).toContain("it is not an entry the registry's rules allow");
    expect(reasonOf(result)).toContain("A changed key is a replace, not a register");
  });

  it("detects a replace whose replaces field is not the key held before it, and an entry dated before the one above", () => {
    const entries = registry();
    const wrongReplaces = { ...entries[2]!, replaces: OPERATOR.fingerprint };
    wrongReplaces.entryHash = customerKeyEntryHash(wrongReplaces);
    expect(verifyCustomerKeyRegistry([entries[0]!, entries[1]!, wrongReplaces])).toEqual({
      ok: false, seq: 2, reason: "its replaces field is not the key the customer held before it.",
    });
    const backdated = { ...entries[2]!, at: "2026-10-20T08:59:59.999Z" };
    backdated.entryHash = customerKeyEntryHash(backdated);
    expect(verifyCustomerKeyRegistry([entries[0]!, entries[1]!, backdated])).toEqual({
      ok: false, seq: 2, reason: "its time (at) is earlier than the entry before it.",
    });
  });

  it("refuses text that is not the file the command writes, naming the line", () => {
    const good = lines();
    expect(reasonOf(readCustomerKeyRegistry(`${good[0]}\nnot json\n`))).toBe("line 2 cannot be read as a registry entry: the line is not valid JSON.");
    expect(reasonOf(readCustomerKeyRegistry(good.join("\n")))).toBe(
      "line 3 cannot be read as a registry entry: the file does not end with a newline: its last line was cut short or edited by hand.",
    );
    expect(reasonOf(readCustomerKeyRegistry(`${good[0]}\n\n${good[1]}\n`))).toBe("line 2 cannot be read as a registry entry: the line is empty.");
    expect(reasonOf(readCustomerKeyRegistry("[]\n"))).toContain("not a registry entry");
    const extra = JSON.stringify({ ...JSON.parse(good[0]!), note: "x" });
    expect(reasonOf(readCustomerKeyRegistry(`${extra}\n`))).toContain("a field this format does not have");
    const badSchema = JSON.stringify({ ...JSON.parse(good[0]!), schema: "mesh-customer-key/2" });
    expect(reasonOf(readCustomerKeyRegistry(`${badSchema}\n`))).toContain("schema is not mesh-customer-key/1");
    const badTime = JSON.stringify({ ...JSON.parse(good[0]!), at: "2026-10-20 09:00" });
    expect(reasonOf(readCustomerKeyRegistry(`${badTime}\n`))).toContain("not an ISO 8601 UTC instant");
    const badAction = JSON.stringify({ ...JSON.parse(good[0]!), action: "delete" });
    expect(reasonOf(readCustomerKeyRegistry(`${badAction}\n`))).toContain("not register, replace or revoke");
  });

  it("KNOWN LIMIT: lines cut off the end still verify, and so does a file rewritten in full; only the head hash differs", () => {
    const entries = registry();
    // The replace is gone: the old key is current again, and the chain is whole.
    const cut = entries.slice(0, 2);
    const result = verifyCustomerKeyRegistry(cut);
    expect(result).toMatchObject({ ok: true, length: 2 });
    expect(currentCustomerKey(cut, ACME)?.fingerprint).toBe(CUSTOMER.fingerprint);
    expect(result.ok && result.headHash).not.toBe(entries[2]!.entryHash);
    // Rewritten from the first line with an earlier date: nothing in the file says so.
    const rewritten = add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: "2026-09-01T09:00:00.000Z" });
    expect(verifyCustomerKeyRegistry(rewritten).ok).toBe(true);
    expect(rewritten[0]!.entryHash).not.toBe(entries[0]!.entryHash);
  });
});

describe("the rules for adding an entry", () => {
  it("refuses to register a customer who already has a current key: that is a replace", () => {
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    const again = refusal(entries, { action: "register", fingerprint: NEW_KEY.fingerprint, at: REPLACED_AT });
    expect(again).toBe(
      `${ACME} already has a current statement key (${CUSTOMER.fingerprint}, registry entry seq 0, ${REGISTERED_AT}). ` +
      "A changed key is a replace, not a register: confirm the change with the customer through the agreed channel, " +
      "separately from any statement, then use replace.",
    );
    // The same key again is refused the same way: nothing is appended twice.
    expect(refusal(entries, { action: "register", fingerprint: CUSTOMER.fingerprint, at: REPLACED_AT })).toContain("already has a current statement key");
  });

  it("replace records the old key, and the new one becomes current from the replace's time", () => {
    const entries = registry();
    expect(entries[2]).toMatchObject({ action: "replace", customer: ACME, fingerprint: NEW_KEY.fingerprint, replaces: CUSTOMER.fingerprint, at: REPLACED_AT });
    expect(currentCustomerKey(entries, ACME)).toEqual({
      fingerprint: NEW_KEY.fingerprint,
      seq: 2,
      at: REPLACED_AT,
      action: "replace",
      channel: "Call to the named contact on the number in the order form",
    });
    expect(customerKeyHistory(entries, ACME).map((entry) => entry.seq)).toEqual([0, 2]);
    expect(registryCustomers(entries)).toEqual([ACME, OTHER]);
  });

  it("replace needs a current key, and a different one", () => {
    expect(refusal([], { action: "replace", fingerprint: NEW_KEY.fingerprint })).toBe(`${ACME} has no current statement key to replace: use register.`);
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    expect(refusal(entries, { action: "replace", fingerprint: CUSTOMER.fingerprint, at: REPLACED_AT })).toContain("there is nothing to replace");
  });

  it("revoke records the key it ends and leaves no current key", () => {
    let entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    entries = add(entries, { action: "revoke", at: REPLACED_AT, channel: "Customer ended the agreement by email" });
    expect(entries[1]).toMatchObject({ action: "revoke", customer: ACME, replaces: CUSTOMER.fingerprint });
    expect("fingerprint" in entries[1]!).toBe(false);
    expect(currentCustomerKey(entries, ACME)).toBeUndefined();
    expect(verifyCustomerKeyRegistry(entries).ok).toBe(true);
    // Nothing left to revoke or replace; a fresh register is allowed again and starts from its own time.
    expect(refusal(entries, { action: "revoke", at: WRITTEN_AT })).toBe(`${ACME} has no current statement key to revoke.`);
    expect(refusal(entries, { action: "replace", fingerprint: NEW_KEY.fingerprint, at: WRITTEN_AT })).toContain("use register");
    entries = add(entries, { action: "register", fingerprint: NEW_KEY.fingerprint, at: WRITTEN_AT });
    expect(currentCustomerKey(entries, ACME)).toMatchObject({ fingerprint: NEW_KEY.fingerprint, seq: 2, at: WRITTEN_AT, action: "register" });
    expect("replaces" in entries[2]!).toBe(false);
  });

  it("revoke needs a current key and names no fingerprint", () => {
    expect(refusal([], { action: "revoke" })).toBe(`${ACME} has no current statement key to revoke.`);
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    expect(refusal(entries, { action: "revoke", fingerprint: CUSTOMER.fingerprint, at: REPLACED_AT })).toContain("a revoke names no fingerprint");
  });

  it("refuses a fingerprint that is the current key of a different customer, for register and for replace", () => {
    const entries = registry();
    const expected =
      `statement key ${OPERATOR.fingerprint} is already the current key of another customer, ${OTHER} ` +
      "(registry entry seq 1, 2026-10-21T09:00:00.000Z). One install's key cannot be two customers' key: check which customer sent it.";
    expect(refusal(entries, { action: "replace", fingerprint: OPERATOR.fingerprint, at: WRITTEN_AT })).toBe(expected);
    expect(refusal(entries, { action: "register", customer: "cus_THIRD", fingerprint: OPERATOR.fingerprint, at: WRITTEN_AT })).toBe(expected);
    // A key no longer current for anyone (ACME's first, replaced) is free to register elsewhere.
    expect(add(entries, { action: "register", customer: "cus_THIRD", fingerprint: CUSTOMER.fingerprint, at: WRITTEN_AT })).toHaveLength(4);
  });

  it("refuses the operator machine's own statement key as a customer's key", () => {
    const expected =
      `statement key ${OPERATOR.fingerprint} is this machine's own MESH install's key, not a customer's. ` +
      "A statement signed by it was written here. The fingerprint to register is the one the customer's own " +
      "`mesh statement --key` prints, sent through the channel agreed in writing.";
    expect(refusal([], { action: "register", fingerprint: OPERATOR.fingerprint, operatorKeyFingerprint: OPERATOR.fingerprint })).toBe(expected);
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    expect(refusal(entries, { action: "replace", fingerprint: OPERATOR.fingerprint, at: REPLACED_AT, operatorKeyFingerprint: OPERATOR.fingerprint })).toBe(expected);
    // Any other key is unaffected by the operator's.
    expect(add([], { action: "register", fingerprint: CUSTOMER.fingerprint, operatorKeyFingerprint: OPERATOR.fingerprint })).toHaveLength(1);
  });

  it("refuses anything that is not 64 lowercase hexadecimal characters as a fingerprint", () => {
    for (const fingerprint of [undefined, "", "abc", CUSTOMER.fingerprint.toUpperCase(), CUSTOMER.fingerprint.slice(1), `${CUSTOMER.fingerprint}0`, ` ${CUSTOMER.fingerprint}`, CUSTOMER.publicKey]) {
      expect(refusal([], { action: "register", ...(fingerprint === undefined ? {} : { fingerprint }) })).toContain("is not a statement key fingerprint");
    }
  });

  it("refuses a customer that is not a Stripe customer id, and a channel note that says nothing", () => {
    for (const customer of ["acme", "cus_", "CUS_ABC", "cus_a b", "cus_abc\n"]) {
      expect(refusal([], { action: "register", customer, fingerprint: CUSTOMER.fingerprint })).toContain("must be a Stripe customer id");
    }
    expect(isCustomerId("cus_TEST")).toBe(true);
    for (const channel of ["", "email", "       ", " padded with spaces "]) {
      expect(refusal([], { action: "register", fingerprint: CUSTOMER.fingerprint, channel })).toContain("the channel note must say how the fingerprint was received");
    }
    expect(refusal([], { action: "register", fingerprint: CUSTOMER.fingerprint, channel: "two\nlines of text" })).toBe("the channel note must be one line of plain text.");
    expect(refusal([], { action: "register", fingerprint: CUSTOMER.fingerprint, channel: "x".repeat(501) })).toContain("longer than 500 characters");
  });

  it("refuses to date an entry before the one above it (a clock that went backwards)", () => {
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint });
    expect(refusal(entries, { action: "replace", fingerprint: NEW_KEY.fingerprint, at: "2026-10-20T08:59:59.999Z" })).toBe(
      `this machine's clock (2026-10-20T08:59:59.999Z) is behind the registry's last entry (seq 0, ${REGISTERED_AT}). ` +
      "An entry is never dated before the one above it: correct the clock and run the command again.",
    );
    // The same instant is allowed: the order in the file decides.
    expect(add(entries, { action: "replace", fingerprint: NEW_KEY.fingerprint, at: REGISTERED_AT })).toHaveLength(2);
  });

  it("adds nothing to a registry whose chain is broken", () => {
    const entries = registry();
    const broken = [entries[0]!, entries[2]!];
    expect(refusal(broken, { action: "register", customer: "cus_THIRD", fingerprint: CUSTOMER.fingerprint, at: WRITTEN_AT })).toContain(
      "the registry's chain is broken at seq 2",
    );
  });
});

describe("checkRegisteredKeyForStatement", () => {
  const oneKey = (): CustomerKeyEntry[] => add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: REGISTERED_AT });

  it("hands back the registered fingerprint and its registration when the key was registered before the statement was written", () => {
    const result = checkRegisteredKeyForStatement({ entries: oneKey(), customer: ACME, statement: statementOf(ledger(), WRITTEN_AT) });
    expect(result).toEqual({
      ok: true,
      fingerprint: CUSTOMER.fingerprint,
      registration: { fingerprint: CUSTOMER.fingerprint, seq: 0, at: REGISTERED_AT, action: "register", channel: CHANNEL },
      statementWrittenAt: WRITTEN_AT,
    });
  });

  it("refuses when the customer has no key: never registered, an empty registry, or another customer's entry only", () => {
    const statement = statementOf(ledger(), WRITTEN_AT);
    const expected =
      `${ACME} has no current statement key in the customer key registry. Register the fingerprint the customer sent through ` +
      "the channel agreed in writing (scripts/mesh-customer-key.ts register), never one read off a statement, then ask the " +
      "customer to write the statement again: a statement written before its key was registered is refused.";
    const empty = checkRegisteredKeyForStatement({ entries: [], customer: ACME, statement });
    expect(empty).toEqual({ ok: false, code: "no-key", reason: expected });
    const others = add([], { action: "register", customer: OTHER, fingerprint: CUSTOMER.fingerprint });
    expect(checkRegisteredKeyForStatement({ entries: others, customer: ACME, statement })).toEqual({ ok: false, code: "no-key", reason: expected });
  });

  it("refuses when the customer's key was revoked, and says when", () => {
    const entries = add(oneKey(), { action: "revoke", at: REPLACED_AT, channel: "Customer ended the agreement by email" });
    const result = checkRegisteredKeyForStatement({ entries, customer: ACME, statement: statementOf(ledger(), WRITTEN_AT) });
    expect(result).toMatchObject({ ok: false, code: "no-key" });
    expect(reasonOf(result)).toContain(`(its key was revoked at ${REPLACED_AT}, registry entry seq 1)`);
  });

  it("refuses when the registry's chain is broken, naming the seq, before anything else is looked at", () => {
    const entries = registry();
    const edited = { ...entries[0]!, at: "2026-10-01T09:00:00.000Z" };
    const result = checkRegisteredKeyForStatement({ entries: [edited, entries[1]!, entries[2]!], customer: ACME, statement: statementOf(ledger(), WRITTEN_AT, NEW_KEY) });
    expect(result).toEqual({
      ok: false,
      code: "registry",
      reason:
        "the customer key registry failed its chain check at seq 0: entryHash does not match the entry's content: the line was edited. " +
        "It was edited by hand or damaged, so no key in it is trusted. Restore it from its backup; do not repair it by hand.",
    });
    // The same for a customer the broken registry does not even name.
    expect(checkRegisteredKeyForStatement({ entries: [entries[0]!, entries[2]!], customer: "cus_NOBODY", statement: null })).toMatchObject({ ok: false, code: "registry" });
  });

  it("refuses a key registered AFTER the statement was written: the fingerprint read off a statement that had already arrived", () => {
    // The statement was written on 3 November; the operator registers the key printed on it the next day.
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: "2026-11-04T10:00:00.000Z" });
    const result = checkRegisteredKeyForStatement({ entries, customer: ACME, statement: statementOf(ledger(), WRITTEN_AT) });
    expect(result).toEqual({
      ok: false,
      code: "order",
      reason:
        `${ACME}'s statement key ${CUSTOMER.fingerprint} was registered at 2026-11-04T10:00:00.000Z, after this statement was written at ` +
        `${WRITTEN_AT} (registry entry seq 0). A key registered after the statement it is used for is the case the signature exists to ` +
        "catch: whoever holds a statement can read a fingerprint off it. The customer must write the statement again now that the key is " +
        "registered. If the fingerprint was copied from this statement and not confirmed with the customer through the agreed channel, " +
        "it is not a registration: revoke it.",
    });
  });

  it("boundary: a key registered at the same instant is refused, one millisecond earlier is allowed", () => {
    const at = (registeredAt: string) =>
      checkRegisteredKeyForStatement({
        entries: add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: registeredAt }),
        customer: ACME,
        statement: statementOf(ledger(), WRITTEN_AT),
      });
    const same = at(WRITTEN_AT);
    expect(same).toMatchObject({ ok: false, code: "order" });
    expect(reasonOf(same)).toContain(`was registered at ${WRITTEN_AT}, the same instant this statement was written (registry entry seq 0)`);
    expect(at("2026-11-03T08:30:00.001Z")).toMatchObject({ ok: false, code: "order" });
    expect(at("2026-11-03T08:29:59.999Z")).toMatchObject({ ok: true, fingerprint: CUSTOMER.fingerprint });
  });

  it("after a replace, the new key counts from the replace: a statement written before it is refused, one written after is allowed", () => {
    const entries = registry(); // ACME: CUSTOMER registered 20 Oct, replaced by NEW_KEY on 2 Nov at 12:00
    const before = checkRegisteredKeyForStatement({ entries, customer: ACME, statement: statementOf(ledger(), "2026-11-02T11:00:00.000Z", NEW_KEY) });
    expect(before).toMatchObject({ ok: false, code: "order" });
    expect(reasonOf(before)).toContain(`statement key ${NEW_KEY.fingerprint} was registered at ${REPLACED_AT}, after this statement was written at 2026-11-02T11:00:00.000Z (registry entry seq 2)`);
    const after = checkRegisteredKeyForStatement({ entries, customer: ACME, statement: statementOf(ledger(), WRITTEN_AT, NEW_KEY) });
    expect(after).toMatchObject({ ok: true, fingerprint: NEW_KEY.fingerprint, registration: { seq: 2, at: REPLACED_AT, action: "replace" } });
  });

  it("reads the statement's time only from a statement that matches its seal", () => {
    const entries = oneKey();
    const statement = statementOf(ledger(), "2026-10-19T00:00:00.000Z"); // written before the key was registered
    expect(checkRegisteredKeyForStatement({ entries, customer: ACME, statement })).toMatchObject({ ok: false, code: "order" });
    // Moving the time forward by hand does not get past the rule: the seal no longer matches.
    const edited = { ...statement, generatedAt: WRITTEN_AT };
    expect(checkRegisteredKeyForStatement({ entries, customer: ACME, statement: edited })).toEqual({
      ok: false, code: "statement", reason: "the statement does not match its sha256 seal: it was edited or damaged after it was written.",
    });
    expect(checkRegisteredKeyForStatement({ entries, customer: ACME, statement: [statement] })).toMatchObject({ ok: false, code: "statement" });
    expect(checkRegisteredKeyForStatement({ entries, customer: ACME, statement: null })).toMatchObject({ ok: false, code: "statement" });
  });

  it("refuses a sealed statement that does not say when it was written", () => {
    const entries = oneKey();
    const undated = checkRegisteredKeyForStatement({ entries, customer: ACME, statement: statementOf(ledger(), undefined) });
    expect(undated).toMatchObject({ ok: false, code: "statement" });
    expect(reasonOf(undated)).toContain("does not say when it was written");
    for (const generatedAt of ["yesterday", "2026-11-03", "2026-11-03T08:30:00Z", "2026-13-03T08:30:00.000Z"]) {
      expect(checkRegisteredKeyForStatement({ entries, customer: ACME, statement: statementOf(ledger(), generatedAt) })).toMatchObject({ ok: false, code: "statement" });
    }
  });
});

describe("the registry wired through the bill's statement check", () => {
  /** What scripts/mesh-bill.ts does: the registry gives the key, then the statement is checked against it. */
  function bill(entries: readonly CustomerKeyEntry[], statement: Record<string, unknown>, files: Ledger = ledger()) {
    const registered = checkRegisteredKeyForStatement({ entries, customer: ACME, statement });
    if (!registered.ok) return { ok: false as const, reason: registered.reason };
    return checkStatementForBilling({
      statement,
      period: PERIOD,
      ...billOf(files),
      expectedKeyFingerprint: registered.fingerprint,
      operatorKeyFingerprint: OPERATOR.fingerprint,
    });
  }

  it("happy path: key registered, then a real signed statement written, then the bill matches it against the registered key", () => {
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: REGISTERED_AT });
    const result = bill(entries, statementOf(ledger(), WRITTEN_AT));
    expect(result).toMatchObject({
      ok: true,
      signedBy: CUSTOMER.fingerprint,
      signerIsRegisteredKey: true,
      spools: 2,
      recordsInPeriod: 5,
      feeCents: 9,
      warnings: [],
    });
    expect(result.ok && result.summary).toContain(`signed by the customer's registered statement key ${CUSTOMER.fingerprint}`);
  });

  it("the wrong order: the statement arrives, the operator registers the key printed on it, and the bill refuses", () => {
    // Whoever wrote this statement signed it with their own key; nothing was registered beforehand.
    const statement = statementOf(ledger(), WRITTEN_AT, NEW_KEY);
    const signature = statement.signature as { fingerprint: string };
    const entries = add([], { action: "register", fingerprint: signature.fingerprint, at: "2026-11-03T09:00:00.000Z" });
    const result = bill(entries, statement);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain("after this statement was written at 2026-11-03T08:30:00.000Z");
    // Without the order rule this statement passes every other check: that is the hole the registry closes.
    expect(checkStatementForBilling({ statement, period: PERIOD, ...billOf(ledger()), expectedKeyFingerprint: signature.fingerprint }).ok).toBe(true);
  });

  it("after a replace, a statement signed by the OLD key is refused by the signature check: the registered fingerprint differs", () => {
    const entries = registry(); // ACME's key replaced on 2 Nov; this statement is written on 3 Nov by the old key
    const result = bill(entries, statementOf(ledger(), WRITTEN_AT, CUSTOMER));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain(
      `the statement is signed by statement key ${CUSTOMER.fingerprint}, which is not the customer's registered key ${NEW_KEY.fingerprint}.`,
    );
    // The same month written again by the new key, after the replace, is accepted.
    expect(bill(entries, statementOf(ledger(), WRITTEN_AT, NEW_KEY))).toMatchObject({ ok: true, signedBy: NEW_KEY.fingerprint, signerIsRegisteredKey: true });
  });

  it("a registered key does not excuse the other checks: a statement signed by the operator's machine is still refused", () => {
    // Registered without telling the command which key is this machine's own (the command always does).
    const entries = add([], { action: "register", fingerprint: OPERATOR.fingerprint, at: REGISTERED_AT });
    const result = bill(entries, statementOf(ledger(), WRITTEN_AT, OPERATOR));
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain("this statement was written on this machine, not by the customer");
  });

  it("a statement whose time was moved after the registration by hand fails its seal, and a re-sealed one fails its signature", () => {
    const entries = add([], { action: "register", fingerprint: CUSTOMER.fingerprint, at: "2026-11-04T10:00:00.000Z" });
    const statement = statementOf(ledger(), WRITTEN_AT);
    const moved: Record<string, unknown> = { ...statement, generatedAt: "2026-11-05T00:00:00.000Z" };
    expect(reasonOf(bill(entries, moved))).toContain("does not match its sha256 seal");
    const resealed = { ...moved, sha256: statementSeal(moved) };
    expect(reasonOf(bill(entries, resealed))).toContain("the statement's signature does not verify");
  });
});
