import { describe, expect, it } from "vitest";
import { anchorChainTip, chainTip, verifyChainAnchor } from "./chain-anchor.js";
import { appendToChain, chainRecord, CHAIN_GENESIS_HASH, type ChainRecord } from "./hash-chain.js";
import { generatePolicyKeyPair } from "./policy-signing.js";

type Entry = { note: string };

function build(notes: string[]): ChainRecord<Entry>[] {
  let records: ChainRecord<Entry>[] = notes.length > 0 ? [chainRecord({ note: notes[0]! })] : [];
  for (const note of notes.slice(1)) records = appendToChain(records, { note });
  return records;
}

const at = "2026-11-07T10:00:00.000Z";

describe("chain anchor", () => {
  it("anchors a tip and verifies the same chain", () => {
    const { signing, verification } = generatePolicyKeyPair("anchor-1");
    const records = build(["a", "b", "c"]);
    const anchor = anchorChainTip(records, signing, at);
    expect(verifyChainAnchor(records, anchor, verification)).toEqual({ valid: true });
  });

  it("reports an empty chain's tip as genesis", () => {
    expect(chainTip([])).toEqual({ length: 0, tipHash: CHAIN_GENESIS_HASH });
  });

  it("detects truncation — a rewritten but internally-consistent shorter chain", () => {
    const { signing, verification } = generatePolicyKeyPair("anchor-1");
    const records = build(["a", "b", "c"]);
    const anchor = anchorChainTip(records, signing, at);
    // Drop the last record and re-anchor nothing: the chain is still internally
    // valid, but no longer matches the signed length.
    const truncated = records.slice(0, 2);
    expect(verifyChainAnchor(truncated, anchor, verification)).toEqual({
      valid: false,
      reason: "length_mismatch",
    });
  });

  it("detects a wholesale rewrite at the same length (tip hash differs)", () => {
    const { signing, verification } = generatePolicyKeyPair("anchor-1");
    const records = build(["a", "b", "c"]);
    const anchor = anchorChainTip(records, signing, at);
    // Forge a brand-new, self-consistent chain of the same length but different
    // content. verifyChain would pass; the anchor catches it.
    const forged = build(["a", "b", "evil"]);
    expect(verifyChainAnchor(forged, anchor, verification)).toEqual({
      valid: false,
      reason: "tip_mismatch",
    });
  });

  it("rejects an anchor signed by an untrusted key", () => {
    const { signing } = generatePolicyKeyPair("anchor-1");
    const attacker = generatePolicyKeyPair("anchor-1"); // same id, different key
    const records = build(["a", "b"]);
    const anchor = anchorChainTip(records, signing, at);
    expect(verifyChainAnchor(records, anchor, attacker.verification)).toEqual({
      valid: false,
      reason: "bad_anchor_signature",
    });
  });
});
