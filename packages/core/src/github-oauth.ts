import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GithubIdentity } from "./accounts.js";

/**
 * GitHub OAuth — the one identity step in signup. First login auto-creates the
 * account (no approval), so this module only needs to (a) build the authorize
 * URL, (b) issue and verify a stateless CSRF `state`, and (c) exchange the
 * returned code for a stable GitHub identity.
 *
 * The `state` is an HMAC-signed `nonce.timestamp` rather than server-side
 * session storage, so the API stays stateless and horizontally scalable. The
 * fetch calls are injectable so the whole exchange is unit-testable with no
 * network.
 *
 * Only identity is read: numeric GitHub id (stable across renames), login, and
 * a verified primary email when the user has shared one. The short-lived access
 * token is used for those two reads and then discarded — never stored.
 */

export type GithubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** Where GitHub redirects back with the code; must match the OAuth app setting. */
  redirectUri: string;
  /** Secret for signing the stateless `state` token. */
  stateSecret: string;
  /** Scopes requested. Default: read:user user:email (identity + email only). */
  scope?: string;
};

const AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";
const EMAILS_ENDPOINT = "https://api.github.com/user/emails";
const DEFAULT_SCOPE = "read:user user:email";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a signed, time-stamped CSRF state token. */
export function createOAuthState(secret: string, now: number = Date.now()): string {
  const payload = `${randomBytes(12).toString("base64url")}.${now}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Verify a state token's signature and freshness (constant-time on the signature). */
export function verifyOAuthState(
  secret: string,
  state: string,
  now: number = Date.now(),
  maxAgeMs: number = STATE_MAX_AGE_MS,
): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, tsText, signature] = parts as [string, string, string];
  const expected = sign(secret, `${nonce}.${tsText}`);
  const got = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  const ts = Number(tsText);
  if (!Number.isFinite(ts)) return false;
  return now - ts >= 0 && now - ts <= maxAgeMs;
}

/** Build the GitHub authorize URL a browser is redirected to. Pure. */
export function buildAuthorizeUrl(config: GithubOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope ?? DEFAULT_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

export type OAuthFetch = typeof fetch;

type GithubUser = { id: number; login: string; email: string | null };
type GithubEmail = { email: string; primary: boolean; verified: boolean };

/**
 * Exchange an authorization code for a GitHub identity: swap code → access
 * token, then read the user and their verified primary email. The token never
 * leaves this function.
 */
export async function exchangeCodeForIdentity(
  config: GithubOAuthConfig,
  code: string,
  deps: { fetch?: OAuthFetch } = {},
): Promise<GithubIdentity> {
  const doFetch = deps.fetch ?? fetch;

  const tokenRes = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }).toString(),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(`GitHub token exchange failed: ${tokenJson.error_description ?? tokenJson.error ?? tokenRes.status}`);
  }
  const accessToken = tokenJson.access_token;
  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "mesh-signup",
  };

  const userRes = await doFetch(USER_ENDPOINT, { headers: authHeaders });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  const user = (await userRes.json()) as GithubUser;
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new Error("GitHub user response did not carry a numeric id and login.");
  }

  let email = user.email ?? undefined;
  if (!email) {
    try {
      const emailsRes = await doFetch(EMAILS_ENDPOINT, { headers: authHeaders });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as GithubEmail[];
        const primary = emails.find((candidate) => candidate.primary && candidate.verified)
          ?? emails.find((candidate) => candidate.verified);
        email = primary?.email;
      }
    } catch {
      // Email is optional — the account works without one; the invoice email
      // can be set later. A failed email read never blocks signup.
    }
  }

  return { githubId: user.id, githubLogin: user.login, ...(email === undefined ? {} : { email }) };
}
