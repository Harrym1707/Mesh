import { describe, expect, it } from "vitest";
import {
  generatePolicyKeyPair,
  policyDigest,
  signPolicy,
  verifyPolicy,
} from "./policy-signing.js";

type Policy = { id: string; version: number; rolloutPercentage: number; baseline: { model: string } };

const policy: Policy = { id: "route-chat", version: 3, rolloutPercentage: 25, baseline: { model: "gpt-5" } };
const at = "2026-11-07T10:00:00.000Z";

describe("policy signing", () => {
  it("signs and verifies a policy round-trip", () => {
    const { signing, verification } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    expect(signed.keyId).toBe("k1");
    expect(signed.algorithm).toBe("ed25519");
    expect(signed.digest).toBe(policyDigest(policy));
    expect(verifyPolicy(signed, verification)).toEqual({ valid: true });
  });

  it("the digest is stable across object key order", () => {
    const reordered: Policy = { baseline: { model: "gpt-5" }, rolloutPercentage: 25, version: 3, id: "route-chat" } as Policy;
    expect(policyDigest(reordered)).toBe(policyDigest(policy));
  });

  it("rejects a policy tampered after signing (digest mismatch)", () => {
    const { signing, verification } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    const tampered = { ...signed, policy: { ...signed.policy, rolloutPercentage: 100 } };
    expect(verifyPolicy(tampered, verification)).toEqual({ valid: false, reason: "digest_mismatch" });
  });

  it("rejects a forged signature where the digest still matches", () => {
    const { signing } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    // A different keypair, but reuse keyId k1 so the key check passes and the
    // signature check is what must fail.
    const other = generatePolicyKeyPair("k1");
    expect(verifyPolicy(signed, other.verification)).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects verification under the wrong key id", () => {
    const { signing } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    const rotated = generatePolicyKeyPair("k2");
    expect(verifyPolicy(signed, rotated.verification)).toEqual({ valid: false, reason: "key_mismatch" });
  });

  it("rejects a back/forward-dated signedAt (attribution is signed)", () => {
    const { signing, verification } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    // Move the signing time without re-signing. The policy and its digest are
    // untouched, so this would have verified valid when only the policy was
    // signed — it must now fail because signedAt is inside the signature.
    const backdated = { ...signed, signedAt: "2020-01-01T00:00:00.000Z" };
    expect(verifyPolicy(backdated, verification)).toEqual({ valid: false, reason: "bad_signature" });
    const postdated = { ...signed, signedAt: "2099-01-01T00:00:00.000Z" };
    expect(verifyPolicy(postdated, verification)).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a tampered algorithm label", () => {
    const { signing, verification } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    const relabelled = { ...signed, algorithm: "rsa" as never };
    expect(verifyPolicy(relabelled, verification)).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("does not leak the private key into the signed object", () => {
    const { signing } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    expect(JSON.stringify(signed)).not.toContain("PRIVATE KEY");
  });

  it("a mangled base64 signature fails closed rather than throwing", () => {
    const { signing, verification } = generatePolicyKeyPair("k1");
    const signed = signPolicy(policy, signing, at);
    const broken = { ...signed, signature: "!!!not-base64!!!" };
    expect(verifyPolicy(broken, verification)).toEqual({ valid: false, reason: "bad_signature" });
  });
});
