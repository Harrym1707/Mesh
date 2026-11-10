import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";

/**
 * The API server's billing capability turns on only in TEST mode. buildContext
 * constructs the Stripe client with no allowLive, so a live key in the
 * environment makes the server REFUSE TO BOOT rather than silently arm a live
 * charge rail. This is the automated-path half of the sk_live_ guard: the
 * unattended server can no more construct a live client than the worker can.
 */

/** A data dir under the OS temp root; buildContext does no I/O at open, so nothing is written. */
const DATA_DIR = join(tmpdir(), "mesh-context-test");

describe("buildContext — Stripe billing is test-mode only", () => {
  it("boots with no Stripe key (billing capability simply off)", () => {
    const ctx = buildContext({ MESH_DATA_DIR: DATA_DIR });
    expect(ctx.stripe).toBeUndefined();
  });

  it("arms the Stripe client in TEST mode for an sk_test_ key", () => {
    const ctx = buildContext({ MESH_DATA_DIR: DATA_DIR, MESH_STRIPE_TEST_SECRET_KEY: "sk_test_cafef00d" });
    expect(ctx.stripe?.mode).toBe("test");
  });

  it("REFUSES TO BOOT when a live key is supplied (no allowLive on the server path)", () => {
    expect(() => buildContext({ MESH_DATA_DIR: DATA_DIR, MESH_STRIPE_TEST_SECRET_KEY: "sk_live_deadbeef" })).toThrow(
      /Refusing a LIVE Stripe key/i,
    );
  });

  it("also refuses a live key supplied via the STRIPE_TEST_SECRET_KEY fallback", () => {
    expect(() => buildContext({ MESH_DATA_DIR: DATA_DIR, STRIPE_TEST_SECRET_KEY: "sk_live_deadbeef" })).toThrow(/LIVE/i);
  });
});
