import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STATEMENT_KEY_SCHEMA,
  parseStatementKeyFile,
  serializeStatementKeyFile,
  signStatementSeal,
  statementKeyFingerprint,
  statementKeyFromPrivate,
} from "../../core/src/manual-billing-checks.js";
import { loadOrCreateStatementKey, readStatementKey, statementKeyPath } from "./statement-key.js";

const posix = process.platform !== "win32";
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("the install's statement key file", () => {
  let home: string;
  let path: string;

  beforeEach(() => {
    home = join(mkdtempSync(join(tmpdir(), "mesh-statement-key-")), ".mesh");
    path = statementKeyPath(home);
  });
  afterEach(() => {
    rmSync(join(home, ".."), { recursive: true, force: true });
  });

  it("lives at <MESH home>/identity/statement-key.json", () => {
    expect(path).toBe(join(home, "identity", "statement-key.json"));
  });

  it("is created the first time it is needed, and the same key is read every time after", () => {
    expect(readStatementKey(path)).toBeUndefined();
    const first = loadOrCreateStatementKey(path, new Date("2026-12-01T10:00:00.000Z"));
    expect(first.created).toBe(true);
    expect(first.key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.key.fingerprint).toBe(statementKeyFingerprint(first.key.publicKey));
    const text = readFileSync(path, "utf8");

    const second = loadOrCreateStatementKey(path, new Date("2027-01-01T00:00:00.000Z"));
    expect(second).toEqual({ key: first.key, created: false });
    expect(readStatementKey(path)).toEqual(first.key);
    // Never rewritten: not even its creation date.
    expect(readFileSync(path, "utf8")).toBe(text);
    // No temporary file is left beside it.
    expect(readdirSync(join(home, "identity"))).toEqual(["statement-key.json"]);
  });

  it("writes a file in the documented format that holds a working key", () => {
    const { key } = loadOrCreateStatementKey(path, new Date("2026-12-01T10:00:00.000Z"));
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(file)).toEqual(["schema", "note", "algorithm", "createdAt", "fingerprint", "publicKey", "privateKey"]);
    expect(file).toMatchObject({
      schema: STATEMENT_KEY_SCHEMA,
      algorithm: "ed25519",
      createdAt: "2026-12-01T10:00:00.000Z",
      fingerprint: key.fingerprint,
      publicKey: key.publicKey,
    });
    expect(file.note).toContain("Never share, send or commit this file");
    expect(parseStatementKeyFile(readFileSync(path, "utf8"))).toEqual(key);
    // The private half on disk is the one that produces the public half.
    expect(statementKeyFromPrivate(file.privateKey as string)).toEqual(key);
    expect(signStatementSeal("a".repeat(64), key.privateKey).fingerprint).toBe(key.fingerprint);
  });

  it.runIf(posix)("is owner-only: directory 0700, file 0600, whatever the umask", () => {
    const previous = process.umask(0o000);
    try {
      loadOrCreateStatementKey(path);
    } finally {
      process.umask(previous);
    }
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(home, "identity"))).toBe(0o700);
  });

  it.runIf(posix)("tightens a key file or directory that was left open to others", () => {
    const { key } = loadOrCreateStatementKey(path);
    chmodSync(path, 0o644);
    chmodSync(join(home, "identity"), 0o755);
    expect(readStatementKey(path)).toEqual(key);
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(home, "identity"))).toBe(0o700);
  });

  it.runIf(posix)("tightens an identity directory that already existed before the key did", () => {
    mkdirSync(join(home, "identity"), { recursive: true, mode: 0o755 });
    chmodSync(join(home, "identity"), 0o755);
    loadOrCreateStatementKey(path);
    expect(modeOf(join(home, "identity"))).toBe(0o700);
    expect(modeOf(path)).toBe(0o600);
  });

  it("refuses a file that is there but is not a usable key, and never replaces it", () => {
    mkdirSync(join(home, "identity"), { recursive: true });
    const good = serializeStatementKeyFile(statementKeyFromPrivate(Buffer.alloc(32, 7).toString("base64")), "2026-12-01T00:00:00.000Z");
    const damaged: [string, string][] = [
      ["", "it is not JSON"],
      [good.slice(0, good.length / 2), "it is not JSON"],
      ["null", "it is not a statement key file"],
      [good.replace(STATEMENT_KEY_SCHEMA, "mesh-statement-key/0"), "its schema is not mesh-statement-key/1"],
      [JSON.stringify({ ...(JSON.parse(good) as object), privateKey: "" }), "its private key is missing or is not 32 bytes of base64"],
      [JSON.stringify({ ...(JSON.parse(good) as object), fingerprint: "0".repeat(64) }), "its fingerprint is not the fingerprint of its public key"],
    ];
    for (const [text, reason] of damaged) {
      writeFileSync(path, text);
      for (const attempt of [() => readStatementKey(path), () => loadOrCreateStatementKey(path)]) {
        let message = "";
        try {
          attempt();
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(`The statement key file ${path} exists but is not a usable statement key: ${reason}.`);
        expect(message).toContain("MESH will not replace it for you");
        expect(message).toContain("move the file aside, run `mesh statement --key`, and register the new fingerprint");
        // The message names the file and the fault, never the key.
        expect(message).not.toContain(Buffer.alloc(32, 7).toString("base64"));
      }
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it.runIf(posix && process.getuid?.() !== 0)("refuses a file it cannot read, rather than making a new key", () => {
    const { key } = loadOrCreateStatementKey(path);
    chmodSync(path, 0o000);
    try {
      expect(() => loadOrCreateStatementKey(path)).toThrow(`The statement key file ${path} exists but could not be read (EACCES).`);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readStatementKey(path)).toEqual(key);
  });

  it.runIf(posix && process.getuid?.() !== 0)("says plainly when the key cannot be created because the home is not writable", () => {
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o555);
    try {
      expect(() => loadOrCreateStatementKey(path)).toThrow(
        `This MESH install has no statement key yet, and one could not be created in ${join(home, "identity")} (EACCES). ` +
        "A statement is signed with that key, so none was written.",
      );
    } finally {
      chmodSync(home, 0o755);
    }
    expect(existsSync(path)).toBe(false);
  });

  it("a new key is a deliberate act: move the old file aside and the next use makes another", () => {
    const first = loadOrCreateStatementKey(path);
    renameSync(path, `${path}.replaced-2026-12-01`);
    const second = loadOrCreateStatementKey(path);
    expect(second.created).toBe(true);
    expect(second.key.fingerprint).not.toBe(first.key.fingerprint);
    // The old key is still where it was moved to, untouched.
    expect(parseStatementKeyFile(readFileSync(`${path}.replaced-2026-12-01`, "utf8"))).toEqual(first.key);
    expect(existsSync(path)).toBe(true);
  });
});
