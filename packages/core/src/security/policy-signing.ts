import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalJson } from "../price-catalogue.js";

/**
 * Policy signing — "Use signed policy versions … for production decisions"
 * (`02_TECHNICAL_ARCHITECTURE.md` §10).
 *
 * A routing/quality policy that production traffic follows is signed with a
 * detached Ed25519 signature over its CANONICAL form. Two properties follow:
 *
 *   - Integrity: a tampered policy — a bumped rollout percentage, a swapped
 *     model — no longer verifies against the signature. Nothing can change a
 *     signed policy without re-signing it.
 *   - Attribution: a production decision can cite the signed digest of the
 *     exact policy version it followed (the audit log's `signedDigest` field),
 *     so "which policy was live, and was it the signed one" is answerable.
 *
 * Ed25519 is used because it is deterministic, compact, and a `node:crypto`
 * builtin — `packages/core` keeps its zero-runtime-dependency, node-builtins-
 * only promise (SECURITY.md). Private keys never appear in a signed object:
 * signing takes a key, verification takes only the public key and the
 * signature.
 */

/** A policy signed and ready to ship. The policy itself is unchanged; the signature is detached. */
export type SignedPolicy<Policy> = {
  policy: Policy;
  /** sha256 of the canonical policy, hex. Stable id for the exact version. */
  digest: string;
  /** Ed25519 signature over the canonical policy, base64. */
  signature: string;
  /** Key id of the signing key, so a verifier can select the right public key. */
  keyId: string;
  /** Signing algorithm; fixed today, carried so the format can evolve. */
  algorithm: "ed25519";
  /** ISO-8601 instant the signature was made. */
  signedAt: string;
};

export type SigningKey = {
  keyId: string;
  /** PEM-encoded Ed25519 private key (PKCS#8). */
  privateKeyPem: string;
};

export type VerificationKey = {
  keyId: string;
  /** PEM-encoded Ed25519 public key (SPKI). */
  publicKeyPem: string;
};

/** Generate an Ed25519 keypair as PEM strings, convenient for tests and key rotation. */
export function generatePolicyKeyPair(keyId: string): { signing: SigningKey; verification: VerificationKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signing: { keyId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    verification: { keyId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
}

/** sha256 digest of a policy's canonical form, hex. The stable id for a version. */
export function policyDigest(policy: unknown): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

/**
 * The exact bytes an Ed25519 signature covers: the whole envelope, not just
 * the policy. Signing only the policy would leave `signedAt`, `keyId`, and
 * `algorithm` outside the signature, so a signed policy could be back- or
 * forward-dated (or relabelled) and still verify — the attribution would be
 * forgeable. Binding them all into one canonical payload closes that gap: any
 * change to when/by-which-key/with-what-algorithm a policy was signed breaks
 * verification. `digest` is included too, though it is derived from `policy`.
 */
function signedPayload(parts: {
  policy: unknown;
  digest: string;
  keyId: string;
  algorithm: "ed25519";
  signedAt: string;
}): Buffer {
  return Buffer.from(canonicalJson(parts));
}

/**
 * Sign a policy. The signature covers the full envelope (policy + digest +
 * keyId + algorithm + signedAt) in canonical form, so it is independent of how
 * the policy object happened to be constructed and tamper-evident across every
 * attribution field, not just the policy body.
 */
export function signPolicy<Policy>(policy: Policy, key: SigningKey, signedAt: string): SignedPolicy<Policy> {
  const digest = createHash("sha256").update(canonicalJson(policy)).digest("hex");
  const algorithm = "ed25519" as const;
  const signature = sign(
    null,
    signedPayload({ policy, digest, keyId: key.keyId, algorithm, signedAt }),
    key.privateKeyPem,
  ).toString("base64");
  return { policy, digest, signature, keyId: key.keyId, algorithm, signedAt };
}

export type PolicyVerification =
  | { valid: true }
  | { valid: false; reason: "key_mismatch" | "digest_mismatch" | "bad_signature" };

/**
 * Verify a signed policy against a public key. Fails, in order, on: a key id
 * the verifier was not given, a digest that does not match the policy's
 * canonical form (the policy was altered after signing), or a signature that
 * does not verify. Only `{ valid: true }` should let a policy drive production.
 */
export function verifyPolicy<Policy>(signed: SignedPolicy<Policy>, key: VerificationKey): PolicyVerification {
  if (signed.keyId !== key.keyId) {
    return { valid: false, reason: "key_mismatch" };
  }
  const digest = createHash("sha256").update(canonicalJson(signed.policy)).digest("hex");
  if (digest !== signed.digest) {
    return { valid: false, reason: "digest_mismatch" };
  }
  // Verify against the SAME envelope that was signed. A tampered signedAt,
  // keyId, or algorithm changes these bytes and so fails verification, even
  // though the policy body and its digest are untouched.
  const payload = signedPayload({
    policy: signed.policy,
    digest: signed.digest,
    keyId: signed.keyId,
    algorithm: signed.algorithm,
    signedAt: signed.signedAt,
  });
  let ok = false;
  try {
    ok = verify(null, payload, key.publicKeyPem, Buffer.from(signed.signature, "base64"));
  } catch {
    ok = false;
  }
  return ok ? { valid: true } : { valid: false, reason: "bad_signature" };
}
