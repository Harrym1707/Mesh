import { describe, expect, it } from "vitest";
import { createStripeClient } from "./stripe-client.js";

/**
 * The sk_live_ guard — the single money-safety guarantee that "no amount of
 * configuration can make the unattended system charge real money". The amount
 * re-type gate (checkLiveChargeConfirmation) is tested in stripe-billing.test;
 * this covers the CLIENT CONSTRUCTOR, which is the real wall: the automated
 * signup / metering / billing paths construct the client with no options, so a
 * live key is refused before a single Stripe call can be formed.
 *
 * Every test is hermetic — a throwing fetch is injected so that any accidental
 * network call fails loudly. The guard is proven to refuse (and to accept) a
 * key WITHOUT ever reaching that fetch.
 */

/** A fetch that fails the test if it is ever called. Proves the guard is pre-network. */
const explodingFetch: typeof fetch = (() => {
  throw new Error("createStripeClient must not touch the network while constructing a client.");
}) as unknown as typeof fetch;

describe("createStripeClient — the automated-path sk_live_ guard", () => {
  it("REFUSES a live key on the automated path (allowLive defaults false)", () => {
    // This is how the worker (mesh-bill-worker) and the API server (buildContext)
    // construct the client: no options, so allowLive is false.
    expect(() => createStripeClient("sk_live_deadbeef", { fetch: explodingFetch })).toThrow(
      /Refusing a LIVE Stripe key/i,
    );
  });

  it("refuses a live key even when the default options object is passed explicitly", () => {
    expect(() => createStripeClient("sk_live_deadbeef", {})).toThrow(/LIVE/i);
  });

  it("the refusal happens BEFORE any network call (guard is pre-fetch)", () => {
    // If the guard ever let an sk_live_ key through to a request, the injected
    // fetch would throw a DIFFERENT error. The guard's own message proves it
    // short-circuited first.
    expect(() => createStripeClient("sk_live_deadbeef", { fetch: explodingFetch })).toThrow(
      /Self-serve signup and billing run/i,
    );
  });

  it("accepts a live key ONLY when allowLive is granted deliberately (the human mesh-bill --live path)", () => {
    const client = createStripeClient("sk_live_deadbeef", { allowLive: true, fetch: explodingFetch });
    expect(client.mode).toBe("live");
  });

  it("accepts a test key and reports test mode", () => {
    const client = createStripeClient("sk_test_cafef00d", { fetch: explodingFetch });
    expect(client.mode).toBe("test");
  });

  it("treats a restricted TEST key (rk_test_…) as test mode, not live", () => {
    const client = createStripeClient("rk_test_restricted", { fetch: explodingFetch });
    expect(client.mode).toBe("test");
  });

  it("does not misclassify a key that merely CONTAINS 'sk_live_' later in the string", () => {
    // mode is decided by startsWith, so a test key is never upgraded to live by
    // substring coincidence — the guard keys off the prefix, nothing else.
    const client = createStripeClient("sk_test_sk_live_not_really", { fetch: explodingFetch });
    expect(client.mode).toBe("test");
  });

  it("requires a non-empty secret key", () => {
    expect(() => createStripeClient("", { fetch: explodingFetch })).toThrow(/secret key is required/i);
  });

  it("constructing a live client (even allowed) performs NO network call on its own", () => {
    // Construction must never hit the network; only an explicit method call may.
    // The exploding fetch guarantees this across both test and live construction.
    expect(() => createStripeClient("sk_test_cafef00d", { fetch: explodingFetch })).not.toThrow();
    expect(() => createStripeClient("sk_live_deadbeef", { allowLive: true, fetch: explodingFetch })).not.toThrow();
  });
});
