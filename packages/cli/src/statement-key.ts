/**
 * The statement key of this MESH install: where it lives and how it is made.
 *
 * `mesh statement` signs every statement it writes with an Ed25519 key that is
 * created on this machine the first time it is needed and never leaves it. The
 * customer gives MESH the key's fingerprint once, when billing is agreed; the
 * bill then refuses any statement not signed by that key, so a statement
 * cannot be written by whoever happens to hold the ledger files.
 *
 * The key lives at <MESH home>/identity/statement-key.json (directory mode
 * 0700, file mode 0600). The rules this file keeps:
 *
 *   - created once, atomically, and NEVER overwritten: an existing file is
 *     only ever read;
 *   - a file that is there but cannot be read as a key is an error, not a
 *     reason to make a new one. A changed key changes the fingerprint MESH
 *     holds for the customer, so it has to be a deliberate act: move the old
 *     file aside, run `mesh statement --key`, and register the new fingerprint;
 *   - the private key is never printed, never logged, never put in an error
 *     message and never written anywhere but this one file;
 *   - no network calls.
 *
 * On Windows the mode bits mean little: the file is protected by the user
 * profile's own access control, not by 0600.
 *
 * The key format, the fingerprint and the signing rule are defined in core
 * (manual-billing-checks.ts), shared with the operator's billing script.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Direct module import, not the package barrel (see start.ts).
import {
  STATEMENT_KEY_DIR,
  STATEMENT_KEY_FILE,
  generateStatementKey,
  parseStatementKeyFile,
  serializeStatementKeyFile,
  type StatementKey,
} from "../../core/src/manual-billing-checks.js";

/** Where the statement key lives under a MESH home (~/.mesh). */
export function statementKeyPath(meshHome: string): string {
  return join(meshHome, STATEMENT_KEY_DIR, STATEMENT_KEY_FILE);
}

const HOW_TO_REPLACE =
  "MESH will not replace it for you: a new key has a new fingerprint, and MESH bills only against the fingerprint " +
  "you registered. If the file is damaged, restore it from a backup. To start a new key on purpose, move the file " +
  "aside, run `mesh statement --key`, and register the new fingerprint with MESH through the channel agreed in writing.";

/** Best effort: owner-only. A filesystem without mode bits (Windows, some mounts) is left as it is. */
function ownerOnly(path: string, mode: number): void {
  try {
    if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  } catch { /* no mode bits here */ }
}

/**
 * Read the key at `path`. Returns undefined when there is no file. Throws when
 * there is a file that cannot be read as a statement key; the message names
 * the file and the fault, never its contents.
 */
export function readStatementKey(path: string): StatementKey | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`The statement key file ${path} exists but could not be read (${code}). ${HOW_TO_REPLACE}`);
  }
  let key: StatementKey;
  try {
    key = parseStatementKeyFile(text);
  } catch (error) {
    throw new Error(
      `The statement key file ${path} exists but is not a usable statement key: ${(error as Error).message}. ${HOW_TO_REPLACE}`,
    );
  }
  ownerOnly(dirname(path), 0o700);
  ownerOnly(path, 0o600);
  return key;
}

/**
 * The install's statement key, created if this is the first time it is needed.
 *
 * Creation is atomic and never replaces a file: the key is written in full to
 * a temporary file beside the target, then hard-linked to the target name,
 * which fails if the name already exists. If another `mesh` process got there
 * first, its key is the one that is read back and used.
 */
export function loadOrCreateStatementKey(path: string, now: Date = new Date()): { key: StatementKey; created: boolean } {
  const existing = readStatementKey(path);
  if (existing !== undefined) return { key: existing, created: false };

  const dir = dirname(path);
  const temporary = join(dir, `.${STATEMENT_KEY_FILE}.${process.pid}.${Date.now()}.tmp`);
  const fresh = generateStatementKey();
  let created = true;
  try {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ownerOnly(dir, 0o700);
      // "wx": fail rather than write through anything already at the temporary name.
      const handle = openSync(temporary, "wx", 0o600);
      try {
        writeSync(handle, serializeStatementKeyFile(fresh, now.toISOString()));
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    } catch (error) {
      // A home folder that cannot be written to (read-only, a full disk): say so plainly.
      throw new Error(
        `This MESH install has no statement key yet, and one could not be created in ${dir} ` +
        `(${(error as NodeJS.ErrnoException).code ?? "error"}). A statement is signed with that key, so none was written. ` +
        "Make that folder writable by you and run the command again.",
      );
    }
    ownerOnly(temporary, 0o600);
    try {
      linkSync(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        created = false; // another process created the key first: use theirs
      } else {
        // No hard links on this filesystem. COPYFILE_EXCL still refuses to replace a file.
        try {
          copyFileSync(temporary, path, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new Error(`The statement key could not be written to ${path} (${(copyError as NodeJS.ErrnoException).code ?? "error"}).`);
          }
          created = false;
        }
      }
    }
  } finally {
    // Only ever this process's own temporary file; a failure to remove it must not hide the real error.
    try { rmSync(temporary, { force: true }); } catch { /* left behind; it is owner-only */ }
  }
  ownerOnly(path, 0o600);

  // Read back what is on disk: that file, not the copy in memory, is the install's key.
  const key = readStatementKey(path);
  if (key === undefined) throw new Error(`The statement key could not be written to ${path}.`);
  return { key, created: created && key.fingerprint === fresh.fingerprint };
}
