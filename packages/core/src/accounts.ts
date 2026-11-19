import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The self-serve account model — who MESH bills, and the Mesh account key that
 * authenticates their metering.
 *
 * Two keys are deliberately kept apart and must never be confused:
 *   - The PROVIDER key (Anthropic x-api-key / OpenAI bearer) only ever passes
 *     THROUGH the proxy to the provider. MESH never stores it, and nothing in
 *     this module touches it.
 *   - The MESH ACCOUNT KEY identifies an account to the metering API. It is
 *     generated here, shown to the customer exactly once at signup, and stored
 *     only as a salted-free SHA-256 hash — a leaked store never yields a usable
 *     key, and a presented key is matched by hashing it the same way.
 *
 * The store itself is an in-memory Map keyed by account id, with secondary
 * indexes by GitHub id and by account-key hash. It is pure and synchronous so
 * the whole account lifecycle is unit-testable without a database; the
 * file-backed persistence layer (./account-store.js) wraps one of these.
 */

/** How a customer pays the MESH fee. Chosen by the customer, stored per account. */
export type PaymentChoice =
  /** Stripe pulls the fee automatically against a saved mandate (ACH/BACS/SEPA). */
  | "direct_debit"
  /** MESH finalizes an invoice and the customer pays it by bank transfer themselves. */
  | "bank_transfer";

export type DirectDebitMandate = {
  /** The Stripe SetupIntent that collected the mandate. */
  setupIntentId?: string;
  /** The saved payment method the fee is pulled from. */
  paymentMethodId?: string;
  /** "pending" until the mandate is confirmed; "active" once it can be charged. */
  status: "pending" | "active";
};

/**
 * The terminal state of one account-period in the durable billing record.
 *
 *   - "noticed"        — an advance "upcoming charge" notice was issued; the
 *                        prerequisite for an automatic direct-debit pull.
 *   - "charged"        — the period was billed. The hard idempotency marker:
 *                        a charged period NEVER charges again, independent of
 *                        Stripe's 24h idempotency-key window and of any later
 *                        amount change.
 *   - "held"           — a charge was formed but withheld (over the ceiling, no
 *                        advance notice, or a savings re-derivation mismatch).
 *                        Not terminal: the period may be re-run once the hold
 *                        is cleared.
 *   - "do_not_charge"  — the period settled owing nothing (non-positive net
 *                        verified savings). Terminal: its deficit has rolled
 *                        forward, so it is never re-settled.
 */
export type BilledPeriodStatus = "noticed" | "charged" | "held" | "do_not_charge";

/**
 * One durable per-account, per-period billing record. This is the money-safety
 * ground truth that outlives Stripe's short-lived idempotency keys: before any
 * charge the worker consults it, and a period already "charged" can never be
 * charged a second time.
 */
export type BilledPeriodRecord = {
  /** Invoice period (YYYY-MM) this record settles. The idempotency key. */
  period: string;
  status: BilledPeriodStatus;
  /** The rail the charge used / would use. */
  rail?: PaymentChoice;
  /** The Stripe invoice id once an invoice was created for this period. */
  invoiceId?: string;
  /** Amount actually charged (integer cents) when status is "charged". */
  chargedCents?: number;
  /** ISO timestamp an advance notice was last issued (gate for a direct-debit pull). */
  advanceNoticeAt?: string;
  /** ISO timestamp the charge settled, when status is "charged". */
  chargedAt?: string;
  /** Why a charge was withheld, when status is "held". */
  heldReason?: string;
  updatedAt: string;
};

export type Account = {
  /** Stable internal id, acct_…, never derived from anything guessable. */
  id: string;
  /** GitHub's numeric user id — stable across username changes, the real identity. */
  githubId: number;
  /** GitHub login at last sign-in, for display and the admin list. */
  githubLogin: string;
  /** Primary verified email from GitHub, when the user shared one. */
  email?: string;
  /** Stripe customer (cus_…), created once at signup; absent only if Stripe was unreachable. */
  stripeCustomerId?: string;
  /** SHA-256 hex of the live account key. The key itself is never stored. */
  accountKeyHash: string;
  /**
   * The non-secret leading segment of the key (e.g. mesh_sk_ab12cd34), kept so
   * the admin API and the customer can identify WHICH key is live without ever
   * seeing or storing the secret tail.
   */
  accountKeyPrefix: string;
  /** direct_debit | bank_transfer, once the customer has chosen. */
  paymentChoice?: PaymentChoice;
  /** Mandate state when paymentChoice is direct_debit. */
  directDebitMandate?: DirectDebitMandate;
  /** MESH's contracted share of net verified savings, 0–100. Default 1. */
  feePercent: number;
  /**
   * Durable per-period billing records — the persistent idempotency + gate
   * state that survives process restarts and outlives Stripe's 24h
   * idempotency-key window. Keyed (and kept unique) by period.
   */
  billedPeriods?: BilledPeriodRecord[];
  /**
   * Running verified-savings deficit (USD, non-negative) carried into the NEXT
   * billing run. The ESPC G.5 mechanic made durable: a period whose net
   * verified savings were non-positive rolls its shortfall forward, offsetting
   * future fees, so AGGREGATE fees can never exceed AGGREGATE verified savings.
   */
  carryForwardDeficitUsd?: number;
  createdAt: string;
  updatedAt: string;
};

/** The default MESH fee: 1% of net verified savings. */
export const DEFAULT_FEE_PERCENT = 1;

const ACCOUNT_KEY_PREFIX = "mesh_sk_";

/** Hash an account key exactly as it is stored and looked up. */
export function hashAccountKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The non-secret display prefix of a key (scheme + first 8 chars of the secret). */
export function accountKeyPrefixOf(key: string): string {
  const secret = key.startsWith(ACCOUNT_KEY_PREFIX) ? key.slice(ACCOUNT_KEY_PREFIX.length) : key;
  return `${ACCOUNT_KEY_PREFIX}${secret.slice(0, 8)}`;
}

/**
 * Generate a fresh account key. Returns the plaintext key (shown to the
 * customer ONCE) plus the hash and prefix that are safe to persist.
 */
export function generateAccountKey(): { key: string; hash: string; prefix: string } {
  const key = `${ACCOUNT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashAccountKey(key), prefix: accountKeyPrefixOf(key) };
}

function newAccountId(): string {
  return `acct_${randomBytes(16).toString("base64url")}`;
}

/** Constant-time compare of two SHA-256 hex digests (key lookup must not leak timing). */
export function accountKeyHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** A view of an account that is safe to return over the API — never the key hash. */
export type PublicAccount = {
  id: string;
  githubLogin: string;
  email?: string;
  stripeCustomerId?: string;
  accountKeyPrefix: string;
  paymentChoice?: PaymentChoice;
  directDebitMandateStatus?: DirectDebitMandate["status"];
  feePercent: number;
  createdAt: string;
  updatedAt: string;
};

/** Strip the secret-adjacent fields so an account can be safely serialized to a client. */
export function redactAccount(account: Account): PublicAccount {
  return {
    id: account.id,
    githubLogin: account.githubLogin,
    ...(account.email === undefined ? {} : { email: account.email }),
    ...(account.stripeCustomerId === undefined ? {} : { stripeCustomerId: account.stripeCustomerId }),
    accountKeyPrefix: account.accountKeyPrefix,
    ...(account.paymentChoice === undefined ? {} : { paymentChoice: account.paymentChoice }),
    ...(account.directDebitMandate === undefined ? {} : { directDebitMandateStatus: account.directDebitMandate.status }),
    feePercent: account.feePercent,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export type GithubIdentity = {
  githubId: number;
  githubLogin: string;
  email?: string;
};

/**
 * In-memory account store with the three lookups the API needs (by id, by
 * GitHub id, by account-key hash). Pure and synchronous. A persistence layer
 * supplies the initial records and observes mutations via `onChange`.
 */
export class AccountStore {
  private readonly byId = new Map<string, Account>();
  private readonly idByGithub = new Map<number, string>();
  private readonly idByKeyHash = new Map<string, string>();

  constructor(
    seed: readonly Account[] = [],
    private readonly onChange?: (account: Account) => void,
  ) {
    for (const account of seed) this.index(account);
  }

  private index(account: Account): void {
    this.byId.set(account.id, account);
    this.idByGithub.set(account.githubId, account.id);
    this.idByKeyHash.set(account.accountKeyHash, account.id);
  }

  list(): Account[] {
    return [...this.byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  get(id: string): Account | undefined {
    return this.byId.get(id);
  }

  findByGithubId(githubId: number): Account | undefined {
    const id = this.idByGithub.get(githubId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  /** Resolve an account from a presented plaintext account key. */
  findByAccountKey(key: string): Account | undefined {
    const id = this.idByKeyHash.get(hashAccountKey(key));
    return id === undefined ? undefined : this.byId.get(id);
  }

  private save(account: Account): Account {
    this.index(account);
    this.onChange?.(account);
    return account;
  }

  /**
   * Find the account for this GitHub identity, or create one. On creation a
   * fresh account key is issued and returned in plaintext (the ONLY time it is
   * available); on an existing account the login/email are refreshed and no key
   * is returned. The caller attaches the Stripe customer id separately.
   */
  upsertFromGithub(
    identity: GithubIdentity,
    now: string = new Date().toISOString(),
  ): { account: Account; created: boolean; accountKey?: string } {
    const existing = this.findByGithubId(identity.githubId);
    if (existing) {
      const updated: Account = {
        ...existing,
        githubLogin: identity.githubLogin,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        updatedAt: now,
      };
      return { account: this.save(updated), created: false };
    }
    const { key, hash, prefix } = generateAccountKey();
    const account: Account = {
      id: newAccountId(),
      githubId: identity.githubId,
      githubLogin: identity.githubLogin,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      accountKeyHash: hash,
      accountKeyPrefix: prefix,
      feePercent: DEFAULT_FEE_PERCENT,
      createdAt: now,
      updatedAt: now,
    };
    return { account: this.save(account), created: true, accountKey: key };
  }

  /** Rotate an account's key, invalidating the old one. Returns the new plaintext key. */
  rotateAccountKey(id: string, now: string = new Date().toISOString()): { account: Account; accountKey: string } | undefined {
    const existing = this.byId.get(id);
    if (!existing) return undefined;
    this.idByKeyHash.delete(existing.accountKeyHash);
    const { key, hash, prefix } = generateAccountKey();
    const updated: Account = { ...existing, accountKeyHash: hash, accountKeyPrefix: prefix, updatedAt: now };
    return { account: this.save(updated), accountKey: key };
  }

  /** Apply a partial update to an account (Stripe id, payment choice, mandate, fee). */
  patch(
    id: string,
    patch: Partial<Pick<Account, "stripeCustomerId" | "paymentChoice" | "directDebitMandate" | "feePercent" | "email">>,
    now: string = new Date().toISOString(),
  ): Account | undefined {
    const existing = this.byId.get(id);
    if (!existing) return undefined;
    const updated: Account = { ...existing, ...patch, updatedAt: now };
    return this.save(updated);
  }

  /** The durable billing record for one account-period, if one has been written. */
  getBilledPeriod(id: string, period: string): BilledPeriodRecord | undefined {
    return this.byId.get(id)?.billedPeriods?.find((record) => record.period === period);
  }

  /**
   * Upsert the durable billing record for one account-period (by period). The
   * whole point of persisting this is money safety, so the write goes through
   * the same synchronous `save`/`onChange` path as every other mutation — it is
   * on disk before the mutating call returns.
   */
  recordBilledPeriod(
    id: string,
    record: BilledPeriodRecord,
    now: string = new Date().toISOString(),
  ): Account | undefined {
    const existing = this.byId.get(id);
    if (!existing) return undefined;
    const kept = (existing.billedPeriods ?? []).filter((r) => r.period !== record.period);
    const billedPeriods = [...kept, { ...record, updatedAt: now }].sort((a, b) =>
      a.period < b.period ? -1 : a.period > b.period ? 1 : 0,
    );
    return this.save({ ...existing, billedPeriods, updatedAt: now });
  }

  /** Persist the running verified-savings deficit carried into the next period. */
  setCarryForwardDeficit(
    id: string,
    deficitUsd: number,
    now: string = new Date().toISOString(),
  ): Account | undefined {
    if (!Number.isFinite(deficitUsd) || deficitUsd < 0) {
      throw new Error("carryForwardDeficitUsd must be a non-negative, finite USD amount.");
    }
    const existing = this.byId.get(id);
    if (!existing) return undefined;
    return this.save({ ...existing, carryForwardDeficitUsd: deficitUsd, updatedAt: now });
  }
}
