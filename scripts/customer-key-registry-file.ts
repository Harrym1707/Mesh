/**
 * Reading the operator's customer key registry from disk.
 *
 * Shared by `scripts/mesh-bill.ts` and `scripts/mesh-customer-key.ts` so both
 * find and read the file the same way. READ ONLY, on purpose: the one place
 * that writes the registry is `scripts/mesh-customer-key.ts`, so the billing
 * script has no code path that can change which key a customer holds.
 *
 * The format, the chain and every rule are in
 * packages/core/src/customer-key-registry.ts; this file only does the I/O.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  CUSTOMER_KEY_REGISTRY_ENV,
  customerKeyRegistryPath,
  readCustomerKeyRegistry,
  type CustomerKeyEntry,
} from "../packages/core/dist/src/index.js";

/** The registry file in use: `--registry <file>`, else $MESH_CUSTOMER_KEYS, else ~/.config/mesh/customer-keys.jsonl. */
export function customerKeyRegistryFilePath(flag?: string): string {
  const env = process.env[CUSTOMER_KEY_REGISTRY_ENV];
  return customerKeyRegistryPath({
    ...(flag === undefined ? {} : { flag }),
    ...(env === undefined ? {} : { env }),
    home: homedir(),
  });
}

export type CustomerKeyRegistryFile =
  | { state: "ok"; path: string; entries: CustomerKeyEntry[]; headHash: string }
  /** There is no file at the path. */
  | { state: "missing"; path: string }
  /** There is something at the path and it could not be read (permissions, a folder). */
  | { state: "unreadable"; path: string; reason: string }
  /** It was read, and it is not a registry that verifies: a line is not an entry, or the chain is broken. */
  | { state: "broken"; path: string; reason: string; seq?: number };

/** Read and verify the registry at `path`. Never throws, never writes. */
export function readCustomerKeyRegistryFile(path: string): CustomerKeyRegistryFile {
  if (!existsSync(path)) return { state: "missing", path };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { state: "unreadable", path, reason: (error as NodeJS.ErrnoException).code ?? "unreadable" };
  }
  const read = readCustomerKeyRegistry(text);
  if (!read.ok) return { state: "broken", path, reason: read.reason, ...(read.seq === undefined ? {} : { seq: read.seq }) };
  return { state: "ok", path, entries: read.entries, headHash: read.headHash };
}
