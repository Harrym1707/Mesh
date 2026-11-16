import { describe, expect, it } from "vitest";
import {
  AccountStore,
  accountKeyPrefixOf,
  generateAccountKey,
  hashAccountKey,
  redactAccount,
  type GithubIdentity,
} from "./accounts.js";

const alice: GithubIdentity = { githubId: 4242, githubLogin: "alice", email: "alice@example.com" };

describe("account keys", () => {
  it("generates a mesh_sk_ key whose hash and prefix are derived deterministically", () => {
    const { key, hash, prefix } = generateAccountKey();
    expect(key.startsWith("mesh_sk_")).toBe(true);
    expect(hash).toBe(hashAccountKey(key));
    expect(prefix).toBe(accountKeyPrefixOf(key));
    expect(prefix.length).toBe("mesh_sk_".length + 8);
    expect(key).not.toContain(hash); // the secret is not recoverable from the prefix
  });

  it("produces distinct keys each call", () => {
    expect(generateAccountKey().key).not.toBe(generateAccountKey().key);
  });
});

describe("AccountStore.upsertFromGithub", () => {
  it("creates an account and issues a key exactly once on first login", () => {
    const store = new AccountStore();
    const first = store.upsertFromGithub(alice, "2026-01-01T00:00:00.000Z");
    expect(first.created).toBe(true);
    expect(first.accountKey).toBeDefined();
    expect(first.account.id.startsWith("acct_")).toBe(true);
    expect(first.account.feePercent).toBe(1);
    // The plaintext key is never persisted — only its hash.
    expect(first.account.accountKeyHash).toBe(hashAccountKey(first.accountKey!));
  });

  it("returns the same account and NO key on a returning login, refreshing login/email", () => {
    const store = new AccountStore();
    const first = store.upsertFromGithub(alice, "2026-01-01T00:00:00.000Z");
    const second = store.upsertFromGithub(
      { githubId: 4242, githubLogin: "alice-renamed", email: "alice@new.example" },
      "2026-02-01T00:00:00.000Z",
    );
    expect(second.created).toBe(false);
    expect(second.accountKey).toBeUndefined();
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.githubLogin).toBe("alice-renamed");
    expect(second.account.email).toBe("alice@new.example");
    expect(second.account.accountKeyHash).toBe(first.account.accountKeyHash);
  });
});

describe("AccountStore lookups and mutations", () => {
  it("resolves an account from a presented plaintext key, and not from a wrong one", () => {
    const store = new AccountStore();
    const { account, accountKey } = store.upsertFromGithub(alice);
    expect(store.findByAccountKey(accountKey!)?.id).toBe(account.id);
    expect(store.findByAccountKey("mesh_sk_not-a-real-key")).toBeUndefined();
  });

  it("rotating a key invalidates the old key and validates the new one", () => {
    const store = new AccountStore();
    const { account, accountKey } = store.upsertFromGithub(alice);
    const rotated = store.rotateAccountKey(account.id)!;
    expect(rotated.accountKey).not.toBe(accountKey);
    expect(store.findByAccountKey(accountKey!)).toBeUndefined();
    expect(store.findByAccountKey(rotated.accountKey)?.id).toBe(account.id);
  });

  it("patch stores the Stripe id and payment choice without touching the key", () => {
    const store = new AccountStore();
    const { account } = store.upsertFromGithub(alice);
    const patched = store.patch(account.id, { stripeCustomerId: "cus_TEST", paymentChoice: "bank_transfer" })!;
    expect(patched.stripeCustomerId).toBe("cus_TEST");
    expect(patched.paymentChoice).toBe("bank_transfer");
    expect(patched.accountKeyHash).toBe(account.accountKeyHash);
  });

  it("redactAccount never leaks the key hash", () => {
    const store = new AccountStore();
    const { account } = store.upsertFromGithub(alice);
    const publicView = redactAccount(account) as Record<string, unknown>;
    expect(publicView.accountKeyHash).toBeUndefined();
    expect(publicView.accountKeyPrefix).toBe(account.accountKeyPrefix);
    expect(JSON.stringify(publicView)).not.toContain(account.accountKeyHash);
  });

  it("notifies onChange for every mutation so a persistence layer can flush", () => {
    const changes: string[] = [];
    const store = new AccountStore([], (acc) => changes.push(acc.id));
    const { account } = store.upsertFromGithub(alice);
    store.patch(account.id, { feePercent: 2 });
    store.rotateAccountKey(account.id);
    expect(changes.length).toBe(3);
    expect(new Set(changes)).toEqual(new Set([account.id]));
  });
});
