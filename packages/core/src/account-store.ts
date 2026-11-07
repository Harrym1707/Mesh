import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AccountStore, type Account } from "./accounts.js";

/**
 * Durable, file-backed account store: an {@link AccountStore} whose records are
 * loaded from and written back to a single JSON file. Writes are whole-file and
 * atomic (temp file + rename) because the account set is tiny (one record per
 * customer) and correctness matters more than write throughput — a torn write
 * would corrupt the billing identity for every customer at once.
 *
 * The file holds account metadata and the account-key HASH only; never a
 * plaintext key and never any provider credential.
 */

type Persisted = { version: 1; accounts: Account[] };

function loadAccounts(path: string): Account[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  const parsed = JSON.parse(raw) as Persisted;
  if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
    throw new Error(`Account store at ${path} is not a version-1 account file.`);
  }
  return parsed.accounts;
}

/**
 * Open (or create) a file-backed account store. The returned store persists
 * every mutation synchronously before the mutating call returns, so a crash
 * after signup can never lose the account a customer was just handed a key for.
 */
export function openFileAccountStore(path: string): AccountStore {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("The account store needs a file path for its JSON record.");
  }
  const seed = loadAccounts(path);
  // The store is constructed first so `write` can enumerate every account
  // (not just the one that changed) for the whole-file atomic rewrite.
  let store: AccountStore;
  const write = (): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const body: Persisted = { version: 1, accounts: store.list() };
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  };
  store = new AccountStore(seed, () => write());
  return store;
}
