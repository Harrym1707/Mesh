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
}
