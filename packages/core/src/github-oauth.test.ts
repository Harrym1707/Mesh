import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForIdentity,
  verifyOAuthState,
  type GithubOAuthConfig,
} from "./github-oauth.js";

const config: GithubOAuthConfig = {
  clientId: "Iv1.test",
  clientSecret: "shh",
  redirectUri: "https://www.mesh-technology.com/v1/auth/github/callback",
  stateSecret: "state-secret",
};

describe("OAuth state", () => {
  it("round-trips a freshly signed state", () => {
    const state = createOAuthState(config.stateSecret, 1_000_000);
    expect(verifyOAuthState(config.stateSecret, state, 1_000_500)).toBe(true);
  });

  it("rejects a tampered state, a wrong secret, and an expired state", () => {
    const state = createOAuthState(config.stateSecret, 1_000_000);
    expect(verifyOAuthState(config.stateSecret, `${state}x`, 1_000_500)).toBe(false);
    expect(verifyOAuthState("other-secret", state, 1_000_500)).toBe(false);
    expect(verifyOAuthState(config.stateSecret, state, 1_000_000 + 11 * 60 * 1000)).toBe(false);
    expect(verifyOAuthState(config.stateSecret, "not.a.state", 1_000_500)).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries client id, redirect, scope and state", () => {
    const url = new URL(buildAuthorizeUrl(config, "STATE123"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.test");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("state")).toBe("STATE123");
  });
});

describe("exchangeCodeForIdentity", () => {
  function jsonResponse(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
  }

  it("swaps code for a stable identity using the user's own email", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.includes("access_token")) return jsonResponse({ access_token: "gho_test" });
      if (u.endsWith("/user")) return jsonResponse({ id: 99, login: "bob", email: "bob@corp.dev" });
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;

    const identity = await exchangeCodeForIdentity(config, "code123", { fetch: fakeFetch });
    expect(identity).toEqual({ githubId: 99, githubLogin: "bob", email: "bob@corp.dev" });
    expect(calls.some((c) => c.includes("access_token"))).toBe(true);
  });

  it("falls back to the verified primary email when the profile email is null", async () => {
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("access_token")) return jsonResponse({ access_token: "gho_test" });
      if (u.endsWith("/user")) return jsonResponse({ id: 7, login: "carol", email: null });
      if (u.endsWith("/user/emails")) {
        return jsonResponse([
          { email: "old@x.dev", primary: false, verified: true },
          { email: "carol@x.dev", primary: true, verified: true },
        ]);
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;

    const identity = await exchangeCodeForIdentity(config, "code", { fetch: fakeFetch });
    expect(identity.email).toBe("carol@x.dev");
  });

  it("throws when the token exchange fails", async () => {
    const fakeFetch = (async () => jsonResponse({ error: "bad_verification_code" }, false)) as typeof fetch;
    await expect(exchangeCodeForIdentity(config, "bad", { fetch: fakeFetch })).rejects.toThrow(/token exchange failed/);
  });
});
