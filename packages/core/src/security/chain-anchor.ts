import { CHAIN_GENESIS_HASH, type ChainRecord } from "./hash-chain.js";
import {
  signPolicy,
  verifyPolicy,
  type SignedPolicy,
  type SigningKey,
  type VerificationKey,
} from "./policy-signing.js";

/**
 * External anchoring for a hash chain — the step that turns tamper-EVIDENT
 * into tamper-PROOF (see the note in `hash-chain.ts`).
 *
 * A hash chain only proves internal consistency; an attacker who rewrites the
 * whole stored array can recompute every hash and forge a consistent chain. An
 * anchor defeats that by Ed25519-signing the chain's TIP — its length and the
 * last `entryHash` — with a key the attacker does not hold. A verifier who
 * trusts the signing key can then catch a truncated or wholesale-rewritten
 * chain, because its tip no longer matches the signed anchor.
 *
 * Produce an anchor periodically (e.g. hourly) and store it somewhere the
 * chain's writer cannot silently overwrite (an external append-only store, a
 * transparency log, a countersignature). Reuses `policy-signing` so there is
 * exactly one signing primitive in the security module.
 */

export type ChainTip = {
  /** Number of records at the moment of anchoring. */
  length: number;
  /** The last record's `entryHash`, or genesis for an empty chain. */
  tipHash: string;
};

export type ChainAnchor = SignedPolicy<ChainTip>;

/** The tip of a chain: its length and last entry hash (genesis when empty). */
export function chainTip<Entry>(records: readonly ChainRecord<Entry>[]): ChainTip {
  const last = records.length > 0 ? records[records.length - 1]! : undefined;
  return { length: records.length, tipHash: last ? last.entryHash : CHAIN_GENESIS_HASH };
}

/** Sign the current tip of a chain, producing a portable, verifiable anchor. */
export function anchorChainTip<Entry>(
  records: readonly ChainRecord<Entry>[],
  key: SigningKey,
  signedAt: string,
): ChainAnchor {
  return signPolicy(chainTip(records), key, signedAt);
}

export type ChainAnchorVerification =
  | { valid: true }
  | { valid: false; reason: "bad_anchor_signature" | "length_mismatch" | "tip_mismatch" };

/**
 * Verify a chain against a signed anchor. Fails on a forged/invalid anchor
 * signature, a length that no longer matches (truncation or extension), or a
 * tip hash that no longer matches (a rewrite). Pair with `verifyChain` for the
 * full guarantee: `verifyChain` proves internal consistency, this proves the
 * chain is the same one that was anchored.
 */
export function verifyChainAnchor<Entry>(
  records: readonly ChainRecord<Entry>[],
  anchor: ChainAnchor,
  key: VerificationKey,
): ChainAnchorVerification {
  if (verifyPolicy(anchor, key).valid !== true) {
    return { valid: false, reason: "bad_anchor_signature" };
  }
  const tip = chainTip(records);
  if (tip.length !== anchor.policy.length) {
    return { valid: false, reason: "length_mismatch" };
  }
  if (tip.tipHash !== anchor.policy.tipHash) {
    return { valid: false, reason: "tip_mismatch" };
  }
  return { valid: true };
}
