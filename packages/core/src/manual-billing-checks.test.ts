import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STATEMENT_KEY_NOTE,
  STATEMENT_KEY_SCHEMA,
  STATEMENT_SCHEMA,
  STATEMENT_SEAL_RULE,
  STATEMENT_SIGNATURE_RULE,
  checkPeriodEnded,
  checkStatementForBilling,
  checkStatementSeal,
  describeBillSpool,
  generateStatementKey,
  isStatementKeyFingerprint,
  parseStatementKeyFile,
  periodEndsAt,
  serializeStatementKeyFile,
  signStatementSeal,
  statementKeyFingerprint,
  statementKeyFromPrivate,
  statementSeal,
  unsignedStatementOrigin,
  verifyStatementSignature,
  type BillSpool,
  type StatementBillingCheckInput,
  type StatementSignature,
} from "./manual-billing-checks.js";
import { chainLedgerRecord, recomputeInvoice, verifyLedgerChain, type BillableEvent, type LedgerRecord } from "./savings-ledger.js";
import { buildStripeInvoicePlan } from "./stripe-billing.js";

const PERIOD = "2026-10";

// Fixed test keys: the secret and public keys of RFC 8032 section 7.1, tests 1
// and 2. Published test vectors, not anyone's key.
const hexToBase64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
const CUSTOMER_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const CUSTOMER = statementKeyFromPrivate(hexToBase64("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
const OPERATOR_PUBLIC_HEX = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const OPERATOR = statementKeyFromPrivate(hexToBase64("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"));

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

/** Two spools: $9.5947 net in 2026-10 across both, plus one September record. */
function ledger(): Ledger {
  counter = 0;
  return {
    "app-anthropic.jsonl": chain([saved(1, "2026-09"), saved(4), saved(3.0947), saved(0.5)]),
    "app-openai.jsonl": chain([saved(1.5), saved(0.5)]),
  };
}

/** What the bill itself computes from the files in hand: scripts/mesh-bill.ts's sequence. */
function billOf(files: Ledger, period = PERIOD) {
  const spools: BillSpool[] = Object.entries(files).map(([name, records]) => describeBillSpool(name, records, period));
  const chainVerified = Object.values(files).every((records) => verifyLedgerChain(records).ok);
  const invoice = recomputeInvoice(Object.values(files).flatMap((records) => records.map((r) => r.event)), { period, feePercent: 1 });
  const plan = buildStripeInvoicePlan(invoice, chainVerified, { stripeCustomerId: "cus_TEST" });
  return {
    spools,
    bill: {
      netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
      feeCents: plan.action === "bill" ? plan.amountCents : 0,
      feePercent: 1,
    },
  };
}

/** Sealed, not signed: what release 0.2.4 wrote. */
function unsignedStatementOf(files: Ledger, period = PERIOD, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { spools, bill } = billOf(files, period);
  const body: Record<string, unknown> = {
    schema: STATEMENT_SCHEMA,
    kind: "statement",
    period: { id: period, timezone: "UTC", closed: true },
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
    ...overrides,
  };
  return { ...body, sha256Of: STATEMENT_SEAL_RULE, sha256: statementSeal(body) };
}

/** A sealed and signed statement shaped as `mesh statement` writes it, over the given files. */
function statementOf(
  files: Ledger,
  period = PERIOD,
  overrides: Record<string, unknown> = {},
  signer = CUSTOMER,
): Record<string, unknown> {
  const sealed = unsignedStatementOf(files, period, overrides);
  return { ...sealed, signature: signStatementSeal(sealed.sha256 as string, signer.privateKey) };
}

type CheckExtra = Partial<Pick<StatementBillingCheckInput, "periodMustBeClosed" | "expectedKeyFingerprint" | "keyMustBeRegistered" | "operatorKeyFingerprint">>;

/** The bill's check as a real run makes it: against the customer's registered key. */
const check = (statement: unknown, files: Ledger, period = PERIOD, extra: CheckExtra = {}) =>
  checkStatementForBilling({
    statement,
    period,
    ...billOf(files, period),
    expectedKeyFingerprint: CUSTOMER.fingerprint,
    ...extra,
  });

const reasonOf = (result: ReturnType<typeof checkStatementForBilling>): string => {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.summary}`);
  return result.reason;
};

describe("the statement seal (one definition, shared by the customer's command and the bill)", () => {
  it("matches an untouched statement and fails an edited one", () => {
    const statement = statementOf(ledger());
    expect(checkStatementSeal(statement)).toBe(true);
    expect(statementSeal(statement)).toBe(statement.sha256);
    expect(checkStatementSeal({ ...statement, fee: { ratePercent: 1, amountCents: 0, amountUsd: 0 } })).toBe(false);
    expect(checkStatementSeal({ ...statement, sha256: undefined })).toBe(false);
    expect(checkStatementSeal(null)).toBe(false);
    expect(checkStatementSeal([statement])).toBe(false);
  });

  it("does not depend on key order or on the seal fields themselves", () => {
    const statement = statementOf(ledger());
    const reordered = Object.fromEntries(Object.entries(statement).reverse());
    expect(statementSeal(reordered)).toBe(statement.sha256);
    expect(statementSeal({ ...statement, sha256: "x", sha256Of: "y" })).toBe(statement.sha256);
  });

  it("is the same with and without the signature, so signing does not change it", () => {
    const unsigned = unsignedStatementOf(ledger());
    const signed = statementOf(ledger());
    expect(signed.sha256).toBe(unsigned.sha256);
    expect(checkStatementSeal(signed)).toBe(true);
    expect(checkStatementSeal(unsigned)).toBe(true);
    // Any edit to the body of a signed statement still breaks the seal.
    expect(checkStatementSeal({ ...signed, fee: { ratePercent: 1, amountCents: 8, amountUsd: 0.08 } })).toBe(false);
    expect(checkStatementSeal({ ...signed, period: { id: "2026-09", timezone: "UTC", closed: true } })).toBe(false);
    expect(checkStatementSeal({ ...signed, extra: 1 })).toBe(false);
  });
});

describe("the statement key: fingerprint, key file, sign and verify", () => {
  it("derives the published public key from the published secret key (RFC 8032 test vectors)", () => {
    expect(Buffer.from(CUSTOMER.publicKey, "base64").toString("hex")).toBe(CUSTOMER_PUBLIC_HEX);
    expect(Buffer.from(OPERATOR.publicKey, "base64").toString("hex")).toBe(OPERATOR_PUBLIC_HEX);
  });

  it("the fingerprint is the lowercase hex sha256 of the raw 32-byte public key", () => {
    // sha256 of the RFC 8032 test 1 public key, worked out independently (shasum).
    expect(CUSTOMER.fingerprint).toBe("21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9");
    expect(statementKeyFingerprint(CUSTOMER.publicKey)).toBe(CUSTOMER.fingerprint);
    expect(statementKeyFingerprint(Buffer.from(CUSTOMER_PUBLIC_HEX, "hex"))).toBe(CUSTOMER.fingerprint);
    expect(CUSTOMER.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(OPERATOR.fingerprint).not.toBe(CUSTOMER.fingerprint);
    expect(isStatementKeyFingerprint(CUSTOMER.fingerprint)).toBe(true);
    expect(isStatementKeyFingerprint(CUSTOMER.fingerprint.toUpperCase())).toBe(false);
    expect(isStatementKeyFingerprint(CUSTOMER.fingerprint.slice(1))).toBe(false);
    expect(() => statementKeyFingerprint("not a key")).toThrow("32 bytes");
    expect(() => statementKeyFingerprint(Buffer.alloc(31))).toThrow("32 bytes");
  });

  it("makes a new key each time, and the key file round-trips", () => {
    const one = generateStatementKey();
    const two = generateStatementKey();
    expect(one.fingerprint).not.toBe(two.fingerprint);
    expect(Buffer.from(one.publicKey, "base64")).toHaveLength(32);
    expect(Buffer.from(one.privateKey, "base64")).toHaveLength(32);
    const text = serializeStatementKeyFile(one, "2026-12-01T00:00:00.000Z");
    expect(parseStatementKeyFile(text)).toEqual(one);
    expect(JSON.parse(text)).toMatchObject({ schema: STATEMENT_KEY_SCHEMA, algorithm: "ed25519", note: STATEMENT_KEY_NOTE });
  });

  it("refuses a key file that is not a complete, self-consistent key, without quoting it", () => {
    const good = JSON.parse(serializeStatementKeyFile(CUSTOMER, "2026-12-01T00:00:00.000Z")) as Record<string, unknown>;
    const reasonFor = (file: unknown): string => {
      try {
        parseStatementKeyFile(typeof file === "string" ? file : JSON.stringify(file));
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the key file to be refused");
    };
    expect(reasonFor("")).toBe("it is not JSON");
    expect(reasonFor("{ truncated")).toBe("it is not JSON");
    expect(reasonFor([])).toBe("it is not a statement key file");
    expect(reasonFor({ ...good, schema: "something-else/1" })).toContain("schema");
    expect(reasonFor({ ...good, algorithm: "rsa" })).toContain("algorithm");
    expect(reasonFor({ ...good, privateKey: undefined })).toContain("private key is missing");
    expect(reasonFor({ ...good, privateKey: "AAAA" })).toContain("private key is missing or is not 32 bytes");
    // Another key's public half or fingerprint beside this private key.
    expect(reasonFor({ ...good, publicKey: OPERATOR.publicKey })).toBe("its public key is not the one its private key produces");
    expect(reasonFor({ ...good, fingerprint: OPERATOR.fingerprint })).toBe("its fingerprint is not the fingerprint of its public key");
    for (const file of [{ ...good, publicKey: OPERATOR.publicKey }, { ...good, schema: "x" }, { ...good, fingerprint: "y" }]) {
      expect(reasonFor(file)).not.toContain(CUSTOMER.privateKey);
    }
  });

  it("signs the seal value, and the signature verifies by an independent route", () => {
    const seal = statementSeal({ hello: "world" });
    const signature = signStatementSeal(seal, CUSTOMER.privateKey);
    expect(signature).toEqual({
      algorithm: "ed25519",
      publicKey: CUSTOMER.publicKey,
      fingerprint: CUSTOMER.fingerprint,
      signs: STATEMENT_SIGNATURE_RULE,
      value: expect.stringMatching(/^[A-Za-z0-9+/]{86}==$/) as unknown as string,
    });
    // The private key is not in what goes into the statement.
    expect(JSON.stringify(signature)).not.toContain(CUSTOMER.privateKey);
    // Deterministic: the same key and seal give the same signature.
    expect(signStatementSeal(seal, CUSTOMER.privateKey).value).toBe(signature.value);
    // Verified without any helper from this module: the public key as a JWK,
    // the message as the seal's 64 hex characters in UTF-8.
    const jwk = { kty: "OKP", crv: "Ed25519", x: Buffer.from(CUSTOMER_PUBLIC_HEX, "hex").toString("base64url") };
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    expect(verify(null, Buffer.from(seal, "utf8"), publicKey, Buffer.from(signature.value, "base64"))).toBe(true);
    expect(verify(null, Buffer.from(seal.toUpperCase(), "utf8"), publicKey, Buffer.from(signature.value, "base64"))).toBe(false);
    expect(STATEMENT_SIGNATURE_RULE).toContain("sha256 field");
    expect(() => signStatementSeal("not a seal", CUSTOMER.privateKey)).toThrow("64 lowercase hexadecimal");
    expect(() => signStatementSeal(seal, "not a key")).toThrow("32 bytes");
  });

  it("verifyStatementSignature: a signed statement verifies and names the key that signed it", () => {
    const statement = statementOf(ledger());
    expect(verifyStatementSignature(statement)).toEqual({ ok: true, fingerprint: CUSTOMER.fingerprint });
    // As the operator receives it: written to a file and read back, keys in any order.
    const reread = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(statement).reverse()), null, 2)) as unknown;
    expect(verifyStatementSignature(reread)).toEqual({ ok: true, fingerprint: CUSTOMER.fingerprint });
    expect(verifyStatementSignature(statementOf(ledger(), PERIOD, {}, OPERATOR))).toEqual({ ok: true, fingerprint: OPERATOR.fingerprint });
  });

  it("verifyStatementSignature: unsigned, edited and re-keyed statements do not verify, each for its own reason", () => {
    const statement = statementOf(ledger());
    const signature = statement.signature as StatementSignature;
    const codeOf = (document: unknown): string => {
      const result = verifyStatementSignature(document);
      if (result.ok) throw new Error("expected the signature not to verify");
      return result.code;
    };
    expect(codeOf(unsignedStatementOf(ledger()))).toBe("unsigned");
    expect(codeOf("text")).toBe("seal");
    // An edit to the body fails the seal before the signature is looked at.
    expect(codeOf({ ...statement, fee: { ratePercent: 1, amountCents: 1, amountUsd: 0.01 } })).toBe("seal");
    // An edit to the body WITH the seal recomputed: the seal passes, the signature is over the old seal.
    const resealed = { ...statement, fee: { ratePercent: 1, amountCents: 1, amountUsd: 0.01 } };
    expect(codeOf({ ...resealed, sha256: statementSeal(resealed) })).toBe("invalid");
    // One character of the signature value changed.
    const flipped = signature.value.startsWith("A") ? `B${signature.value.slice(1)}` : `A${signature.value.slice(1)}`;
    expect(codeOf({ ...statement, signature: { ...signature, value: flipped } })).toBe("invalid");
    // Another key's signature over another seal, pasted in.
    const other = signStatementSeal(statementSeal({ other: true }), CUSTOMER.privateKey);
    expect(codeOf({ ...statement, signature: other })).toBe("invalid");
    // The public key swapped for another, with and without its matching fingerprint.
    expect(codeOf({ ...statement, signature: { ...signature, publicKey: OPERATOR.publicKey } })).toBe("malformed");
    expect(codeOf({ ...statement, signature: { ...signature, publicKey: OPERATOR.publicKey, fingerprint: OPERATOR.fingerprint } })).toBe("invalid");
    // The fingerprint swapped for the registered one while the key is another's.
    const operatorSigned = statementOf(ledger(), PERIOD, {}, OPERATOR);
    expect(codeOf({ ...operatorSigned, signature: { ...(operatorSigned.signature as StatementSignature), fingerprint: CUSTOMER.fingerprint } })).toBe("malformed");
    // Not this format.
    expect(codeOf({ ...statement, signature: "signed, honest" })).toBe("malformed");
    expect(codeOf({ ...statement, signature: null })).toBe("malformed");
    expect(codeOf({ ...statement, signature: { ...signature, algorithm: "rsa" } })).toBe("malformed");
    expect(codeOf({ ...statement, signature: { ...signature, signs: "something else" } })).toBe("malformed");
    expect(codeOf({ ...statement, signature: { ...signature, value: "AAAA" } })).toBe("malformed");
    expect(codeOf({ ...statement, signature: { ...signature, publicKey: `${signature.publicKey} ` } })).toBe("malformed");
  });
});

describe("checkPeriodEnded: a period is billed only once it is over in UTC", () => {
  it("refuses the last millisecond of the month and allows the first millisecond of the next", () => {
    expect(periodEndsAt("2026-11").toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(checkPeriodEnded("2026-11", new Date("2026-11-30T23:59:59.999Z"))).toEqual({
      ended: false,
      message: "period 2026-11 has not ended (it ends 2026-12-01T00:00:00.000Z UTC)",
    });
    expect(checkPeriodEnded("2026-11", new Date("2026-12-01T00:00:00.000Z"))).toEqual({ ended: true });
  });

  it("works in UTC whatever the local offset of the time given, and across a year end", () => {
    // 1 December, 00:30 in UTC+2 is still 30 November, 22:30 UTC.
    expect(checkPeriodEnded("2026-11", new Date("2026-12-01T00:30:00.000+02:00")).ended).toBe(false);
    // 30 November, 23:30 in UTC-2 is already 1 December, 01:30 UTC.
    expect(checkPeriodEnded("2026-11", new Date("2026-11-30T23:30:00.000-02:00")).ended).toBe(true);
    expect(periodEndsAt("2026-12").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(checkPeriodEnded("2026-12", new Date("2026-12-31T23:59:59.999Z")).ended).toBe(false);
    expect(checkPeriodEnded("2026-12", new Date("2027-01-01T00:00:00.000Z")).ended).toBe(true);
    expect(checkPeriodEnded("2026-11", new Date("2026-11-19T12:00:00.000Z")).ended).toBe(false);
    expect(checkPeriodEnded("2026-10", new Date("2026-11-19T12:00:00.000Z")).ended).toBe(true);
  });

  it("rejects something that is not a period", () => {
    expect(() => periodEndsAt("2026-13")).toThrow(/not a billing period/);
    expect(() => checkPeriodEnded("all", new Date())).toThrow(/not a billing period/);
  });
});

describe("checkStatementForBilling: the files in hand against the customer's statement", () => {
  it("a matching set passes and says what matched", () => {
    const files = ledger();
    const result = check(statementOf(files), files);
    expect(result).toEqual({
      ok: true,
      summary:
        "statement matched: 2 spools, 6 records (5 in 2026-10), net verified savings $9.5947, fee 9 cents, " +
        `signed by the customer's registered statement key ${CUSTOMER.fingerprint}`,
      spools: 2,
      records: 6,
      recordsInPeriod: 5,
      netVerifiedSavingsUsd: billOf(files).bill.netVerifiedSavingsUsd,
      feeCents: 9,
      signedBy: CUSTOMER.fingerprint,
      signerIsRegisteredKey: true,
      warnings: [],
    });
  });

  it("does not depend on the order the spools are passed in", () => {
    const files = ledger();
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(check(statementOf(files), reversed).ok).toBe(true);
  });

  it("one spool missing: refused, naming the spool the statement expects by head hash and counts", () => {
    const files = ledger();
    const statement = statementOf(files);
    const { "app-openai.jsonl": missing, ...rest } = files;
    const reason = reasonOf(check(statement, rest));
    const missingHead = missing!.at(-1)!.eventHash;
    expect(reason).toBe(
      "the ledger files passed are not the ledger the statement was computed from: " +
      `the statement lists a spool that was not passed (head hash ${missingHead}; expected 2 records, 2 in 2026-10). ` +
      "The statement covers 2 spools; 1 spool passed.",
    );
  });

  it("one spool with its last record removed: still a valid chain, and refused with expected against received", () => {
    const files = ledger();
    const statement = statementOf(files);
    const full = files["app-anthropic.jsonl"]!;
    const cut = full.slice(0, -1);
    // The cut-off spool verifies on its own: the chain alone would not catch this.
    expect(verifyLedgerChain(cut).ok).toBe(true);
    const reason = reasonOf(check(statement, { ...files, "app-anthropic.jsonl": cut }));
    expect(reason).toBe(
      "the ledger files passed are not the ledger the statement was computed from: " +
      `spool app-anthropic.jsonl (head hash ${cut.at(-1)!.eventHash}; 3 records, 2 in 2026-10) matches no spool in the statement; ` +
      `the statement lists a spool that was not passed (head hash ${full.at(-1)!.eventHash}; expected 4 records, 3 in 2026-10). ` +
      "The statement covers 2 spools; 2 spools passed.",
    );
  });

  it("an extra spool, or the same spool passed twice, is refused", () => {
    const files = ledger();
    const statement = statementOf(files);
    counter = 100;
    const extra = chain([saved(2)]);
    expect(reasonOf(check(statement, { ...files, "other-anthropic.jsonl": extra }))).toContain(
      "spool other-anthropic.jsonl (head hash " + extra.at(-1)!.eventHash + "; 1 record, 1 in 2026-10) matches no spool in the statement",
    );
    expect(reasonOf(check(statement, { ...files, "copy.jsonl": files["app-openai.jsonl"]! }))).toContain(
      "spool copy.jsonl",
    );
  });

  it("the same head hash with different counts is refused with both sets of counts", () => {
    const files = ledger();
    const statement = statementOf(files);
    const lied = statementOf(files, PERIOD, {
      ledger: {
        chainVerified: true,
        spools: (statement.ledger as { spools: Record<string, unknown>[] }).spools.map((spool, index) =>
          (index === 0 ? { ...spool, records: 9, recordsInPeriod: 7 } : spool)),
      },
    });
    expect(reasonOf(check(lied, files))).toContain(
      "the statement expects 9 records, 7 in 2026-10; received 4 records, 3 in 2026-10",
    );
  });

  it("a statement for another period is refused", () => {
    const files = ledger();
    const september = statementOf(files, "2026-09");
    expect(reasonOf(check(september, files))).toBe(
      'the statement is for period "2026-09", but the bill is for period 2026-10.',
    );
  });

  it("an edited statement is refused on its seal, before anything else is read from it", () => {
    const files = ledger();
    const statement = statementOf(files);
    const edited = { ...statement, fee: { ratePercent: 1, amountCents: 1, amountUsd: 0.01 } };
    expect(reasonOf(check(edited, files))).toBe(
      "the statement does not match its sha256 seal: it was edited or damaged after it was written.",
    );
    expect(reasonOf(check("not a statement", files))).toContain("not a JSON object");
    expect(reasonOf(check({ hello: "world" }, files))).toContain("sha256 seal");
  });

  it("a statement written before the period ended (closed: false) is refused", () => {
    const files = ledger();
    const open = statementOf(files, PERIOD, { period: { id: PERIOD, timezone: "UTC", closed: false } });
    expect(reasonOf(check(open, files))).toBe(
      "the statement was written before period 2026-10 had ended (closed: false), so its figures could still change. " +
      "Ask for a statement produced after the period ended.",
    );
  });

  it("only a dry run may let an open period through, and then as a warning with the rest still checked", () => {
    const files = ledger();
    const open = statementOf(files, PERIOD, { period: { id: PERIOD, timezone: "UTC", closed: false } });
    const rehearsal = check(open, files, PERIOD, { periodMustBeClosed: false });
    if (!rehearsal.ok) throw new Error(rehearsal.reason);
    expect(rehearsal.warnings).toHaveLength(1);
    expect(rehearsal.warnings[0]).toContain("closed: false");
    expect(rehearsal.feeCents).toBe(9);
    // The spools are still compared in a rehearsal.
    const { "app-openai.jsonl": _missing, ...rest } = files;
    expect(check(open, rest, PERIOD, { periodMustBeClosed: false }).ok).toBe(false);
  });

  it("a fee differing by one cent is refused, with both figures", () => {
    const files = ledger();
    const off = statementOf(files, PERIOD, { fee: { ratePercent: 1, amountCents: 10, amountUsd: 0.1 } });
    expect(reasonOf(check(off, files))).toBe(
      "the fee differs: the statement says 10 cents, the bill's own recompute says 9 cents.",
    );
    const under = statementOf(files, PERIOD, { fee: { ratePercent: 1, amountCents: 8, amountUsd: 0.08 } });
    expect(reasonOf(check(under, files))).toContain("the statement says 8 cents, the bill's own recompute says 9 cents");
  });

  it("differing net savings are refused; floating-point noise is not a difference", () => {
    const files = ledger();
    const net = billOf(files).bill.netVerifiedSavingsUsd;
    const off = statementOf(files, PERIOD, { totals: { netVerifiedSavingsUsd: net + 0.01 } });
    expect(reasonOf(check(off, files))).toBe(
      `net verified savings differ: the statement says $${(net + 0.01).toFixed(6)}, the bill's own recompute says $${net.toFixed(6)}.`,
    );
    const noise = statementOf(files, PERIOD, { totals: { netVerifiedSavingsUsd: net + 1e-13 } });
    expect(check(noise, files).ok).toBe(true);
  });

  it("refuses a statement at another fee rate, of another schema, not valid for billing, or over an unverified ledger", () => {
    const files = ledger();
    expect(reasonOf(check(statementOf(files, PERIOD, { fee: { ratePercent: 2, amountCents: 9 } }), files))).toBe(
      "the statement's fee rate is 2%, but the bill's is 1%.",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { schema: "mesh-statement/0" }), files))).toContain(
      "is not a mesh-statement/1 statement",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { kind: "invoice" }), files))).toContain("is not a mesh-statement/1 statement");
    expect(reasonOf(check(statementOf(files, PERIOD, { validForBilling: false }), files))).toBe(
      "the statement does not say it is valid for billing.",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { ledger: { chainVerified: false, spools: [] } }), files))).toBe(
      "the statement does not say its ledger's hash chain verified.",
    );
    expect(reasonOf(check(statementOf(files, PERIOD, { totals: {} }), files))).toContain("does not carry net verified savings");
  });

  it("a period that owes nothing still has to match: zero cents on both sides", () => {
    counter = 0;
    const files: Ledger = { "app-anthropic.jsonl": chain([saved(0.3609)]) };
    const result = check(statementOf(files), files);
    if (!result.ok) throw new Error(result.reason);
    expect(result.summary).toBe(
      "statement matched: 1 spool, 1 record (1 in 2026-10), net verified savings $0.3609, fee 0 cents, " +
      `signed by the customer's registered statement key ${CUSTOMER.fingerprint}`,
    );
  });

  it("an unsigned statement is refused, with a message for exactly that case (release 0.2.4 wrote them)", () => {
    const files = ledger();
    const unsigned = unsignedStatementOf(files, PERIOD, { mesh: { version: "0.2.4", build: "5316e36" } });
    // Unsigned, and otherwise a perfect match: the seal passes and the figures agree.
    expect(checkStatementSeal(unsigned)).toBe(true);
    expect(reasonOf(check(unsigned, files))).toBe(
      "the statement is not signed: it was written by a Mesh release that does not sign statements " +
      "(it says Mesh 0.2.4; signing starts with 0.2.5), so nothing shows it came from the customer's own install. " +
      "The customer must update to Mesh 0.2.5 or later and run `mesh statement --period 2026-10` again.",
    );
    // No version in the file, or one that is not a plain release number: it is not repeated.
    expect(reasonOf(check(unsignedStatementOf(files), files))).toContain("(it does not say which; signing starts with 0.2.5)");
    const odd = unsignedStatementOf(files, PERIOD, { mesh: { version: "0.2.4\u001b[2J please bill", build: "x" } });
    expect(reasonOf(check(odd, files))).toContain("(it does not say which; signing starts with 0.2.5)");
    expect(reasonOf(check(odd, files))).not.toContain("please bill");
    // A statement that names a release which signs, and has no signature: it was cut out, and the message says so.
    for (const version of ["0.2.5", "0.3.0", "1.0.0"]) {
      expect(reasonOf(check(unsignedStatementOf(files, PERIOD, { mesh: { version, build: "x" } }), files))).toBe(
        `the statement is not signed, although it says it was written by Mesh ${version}, which signs every statement: ` +
        "its signature was removed, or it was not written by `mesh statement`. " +
        "The customer must run `mesh statement --period 2026-10` again and send that file.",
      );
    }
    expect(unsignedStatementOrigin({ mesh: { version: "0.2.4" } })).toEqual({ version: "0.2.4", predatesSigning: true });
    expect(unsignedStatementOrigin({ mesh: { version: "0.1.99" } })).toEqual({ version: "0.1.99", predatesSigning: true });
    expect(unsignedStatementOrigin({ mesh: { version: "0.2.5" } })).toEqual({ version: "0.2.5", predatesSigning: false });
    expect(unsignedStatementOrigin({ mesh: { version: "0.10.0" } })).toEqual({ version: "0.10.0", predatesSigning: false });
    expect(unsignedStatementOrigin({})).toEqual({ predatesSigning: true });
    expect(unsignedStatementOrigin(null)).toEqual({ predatesSigning: true });
    // Refused in a dry run too, with or without a registered key to compare.
    expect(reasonOf(check(unsigned, files, PERIOD, { periodMustBeClosed: false, keyMustBeRegistered: false, expectedKeyFingerprint: undefined })))
      .toContain("the statement is not signed");
  });

  it("a statement whose signature does not verify is refused", () => {
    const files = ledger();
    const statement = statementOf(files);
    const signature = statement.signature as StatementSignature;
    const flipped = signature.value.startsWith("A") ? `B${signature.value.slice(1)}` : `A${signature.value.slice(1)}`;
    expect(reasonOf(check({ ...statement, signature: { ...signature, value: flipped } }, files))).toBe(
      "the statement's signature does not verify: the signature does not verify against the public key in the file. " +
      "The signature, the key or the seal was changed after the statement was signed; ask the customer to write it again.",
    );
    // The registered fingerprint pasted over another key's signature does not get through.
    const operatorSigned = statementOf(files, PERIOD, {}, OPERATOR);
    const relabelled = { ...operatorSigned, signature: { ...(operatorSigned.signature as StatementSignature), fingerprint: CUSTOMER.fingerprint } };
    expect(reasonOf(check(relabelled, files))).toContain("its signature's fingerprint is not the fingerprint of its public key");
    // Nor does the customer's public key pasted over it.
    const rekeyed = { ...operatorSigned, signature: { ...(operatorSigned.signature as StatementSignature), publicKey: CUSTOMER.publicKey, fingerprint: CUSTOMER.fingerprint } };
    expect(reasonOf(check(rekeyed, files))).toContain("the signature does not verify against the public key in the file");
  });

  it("a statement signed by a key that is not the customer's registered key is refused, with both fingerprints", () => {
    const files = ledger();
    // Written from the very same files, sealed and validly signed: only the key is wrong.
    const byAnother = statementOf(files, PERIOD, {}, OPERATOR);
    expect(verifyStatementSignature(byAnother).ok).toBe(true);
    expect(reasonOf(check(byAnother, files))).toBe(
      `the statement is signed by statement key ${OPERATOR.fingerprint}, which is not the customer's registered key ` +
      `${CUSTOMER.fingerprint}. Never accept a new key that arrives with the statement: confirm a changed key ` +
      "with the customer through the agreed channel first (runbook, \"The customer's key changed\").",
    );
    expect(reasonOf(check(statementOf(files), files, PERIOD, { expectedKeyFingerprint: "abc" }))).toContain(
      "is not a statement key fingerprint",
    );
    expect(reasonOf(check(statementOf(files), files, PERIOD, { expectedKeyFingerprint: CUSTOMER.fingerprint.toUpperCase() }))).toContain(
      "is not a statement key fingerprint",
    );
  });

  it("a statement signed by the operator's own install is refused as written on this machine", () => {
    const files = ledger();
    const byOperator = statementOf(files, PERIOD, {}, OPERATOR);
    const expected =
      "this statement was written on this machine, not by the customer: it is signed by this machine's own Mesh install " +
      `(statement key ${OPERATOR.fingerprint}). The statement must be the one the customer wrote on their own machine.`;
    expect(reasonOf(check(byOperator, files, PERIOD, { operatorKeyFingerprint: OPERATOR.fingerprint }))).toBe(expected);
    // Even when the operator's own fingerprint is passed as the customer's, and in a dry run with no customer key.
    expect(reasonOf(check(byOperator, files, PERIOD, {
      operatorKeyFingerprint: OPERATOR.fingerprint, expectedKeyFingerprint: OPERATOR.fingerprint,
    }))).toBe(expected);
    expect(reasonOf(check(byOperator, files, PERIOD, {
      operatorKeyFingerprint: OPERATOR.fingerprint, expectedKeyFingerprint: undefined, keyMustBeRegistered: false, periodMustBeClosed: false,
    }))).toBe(expected);
    // The customer's statement is not affected by the operator having a key.
    expect(check(statementOf(files), files, PERIOD, { operatorKeyFingerprint: OPERATOR.fingerprint }).ok).toBe(true);
  });

  it("with no registered key a real check refuses; only a dry run reports the signer and warns", () => {
    const files = ledger();
    const statement = statementOf(files);
    const notCompared =
      `the statement is signed by statement key ${CUSTOMER.fingerprint}, and no registered customer key was given to compare it with, ` +
      "so who wrote the statement was not checked.";
    expect(reasonOf(check(statement, files, PERIOD, { expectedKeyFingerprint: undefined }))).toBe(notCompared);
    const rehearsal = check(statement, files, PERIOD, { expectedKeyFingerprint: undefined, keyMustBeRegistered: false });
    if (!rehearsal.ok) throw new Error(rehearsal.reason);
    expect(rehearsal.warnings).toEqual([notCompared]);
    expect(rehearsal.signedBy).toBe(CUSTOMER.fingerprint);
    expect(rehearsal.signerIsRegisteredKey).toBe(false);
    expect(rehearsal.summary).toContain(`signed by statement key ${CUSTOMER.fingerprint} (not compared with a registered key)`);
    // keyMustBeRegistered: false does not loosen a comparison that IS made.
    expect(check(statementOf(files, PERIOD, {}, OPERATOR), files, PERIOD, { keyMustBeRegistered: false }).ok).toBe(false);
  });

  it("the signature is checked after the seal and before the period, the spools and the figures", () => {
    const files = ledger();
    // Edited and unsigned: the seal is what is reported.
    const editedUnsigned = { ...unsignedStatementOf(files), fee: { ratePercent: 1, amountCents: 1, amountUsd: 0.01 } };
    expect(reasonOf(check(editedUnsigned, files))).toContain("does not match its sha256 seal");
    // Wrong period, wrong spools and wrong key at once: the key is what is reported.
    const { "app-openai.jsonl": _missing, ...rest } = files;
    expect(reasonOf(check(statementOf(files, "2026-09", {}, OPERATOR), rest))).toContain("is not the customer's registered key");
    expect(reasonOf(check(unsignedStatementOf(files, "2026-09"), rest))).toContain("the statement is not signed");
  });

  it("describeBillSpool counts records in the period and takes the head hash from the last record", () => {
    const files = ledger();
    const records = files["app-anthropic.jsonl"]!;
    expect(describeBillSpool("a.jsonl", records, PERIOD)).toEqual({
      name: "a.jsonl", records: 4, recordsInPeriod: 3, headHash: records.at(-1)!.eventHash,
    });
    expect(describeBillSpool("a.jsonl", records, "2026-09")).toMatchObject({ records: 4, recordsInPeriod: 1 });
    expect(describeBillSpool("empty.jsonl", [], PERIOD)).toEqual({ name: "empty.jsonl", records: 0, recordsInPeriod: 0 });
  });
});
