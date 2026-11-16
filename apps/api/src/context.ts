import { join } from "node:path";
import {
  createStripeClient,
  openFileAccountStore,
  openFileLedgerStore,
  type AccountStore,
  type GithubOAuthConfig,
  type LedgerStore,
  type StripeClient,
} from "../../../packages/core/dist/src/index.js";

/**
 * The server's runtime context: configuration read once from the environment,
 * and the stores/clients the request handlers share.
 *
 * Everything the self-serve flow needs is optional so the API still boots as
 * the local telemetry dashboard with nothing configured. Each capability
 * (GitHub signup, Stripe billing, the admin API) turns on only when its
 * environment is present, and a handler whose capability is off returns a clear
 * 501 rather than throwing at boot.
 */

export type ServerContext = {
  accounts: AccountStore;
  /** Per-account hash-chained ledger spools the metering endpoint appends to. */
  ledger: LedgerStore;
  /** The public origin the claim bridge and OAuth redirect are built from. */
  publicBaseUrl: string;
  /** Directory holding the account file and per-account ledger spools. */
  dataDir: string;
  /** GitHub OAuth config, or undefined when signup is not configured. */
  githubOAuth?: GithubOAuthConfig;
  /** Stripe client (test mode), or undefined when no key is configured. */
  stripe?: StripeClient;
  /** Enabled direct-debit rails, region-agnostic. e.g. ["us_bank_account"]. */
  directDebitPaymentMethods: string[];
  /** Admin API bearer token, or undefined when the admin API is disabled. */
  adminToken?: string;
  /** MESH's default contracted fee percent. */
  defaultFeePercent: number;
};

/**
 * Stripe payment_method_types for direct debit, region-agnostic. The enabled
 * set is configuration (MESH_DIRECT_DEBIT_METHODS), NOT hardcoded to one
 * region — the operator picks ACH / BACS / SEPA (or several) when the first
 * customer's region is known, without a code change.
 */
export const DIRECT_DEBIT_METHOD_BY_REGION: Record<string, string> = {
  us: "us_bank_account", // ACH
  gb: "bacs_debit", // BACS
  eu: "sepa_debit", // SEPA
};

function parseDirectDebitMethods(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") {
    // Default: offer all three rails. Stripe only presents the ones the
    // account + customer currency actually support, so this is safe and keeps
    // signup unblocked before the operator pins a region.
    return Object.values(DIRECT_DEBIT_METHOD_BY_REGION);
  }
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => DIRECT_DEBIT_METHOD_BY_REGION[token.toLowerCase()] ?? token);
}

/** Build the context from process.env. Reads config once; never throws on missing optional config. */
export function buildContext(env: NodeJS.ProcessEnv = process.env): ServerContext {
  const dataDir = env.MESH_DATA_DIR ?? join(process.cwd(), ".mesh-data");
  const publicBaseUrl = (env.MESH_PUBLIC_BASE_URL ?? "https://www.mesh-technology.com").replace(/\/$/, "");
  const accounts = openFileAccountStore(join(dataDir, "accounts.json"));
  const ledger = openFileLedgerStore(join(dataDir, "ledger"));

  const clientId = env.MESH_GITHUB_CLIENT_ID;
  const clientSecret = env.MESH_GITHUB_CLIENT_SECRET;
  const stateSecret = env.MESH_OAUTH_STATE_SECRET ?? clientSecret;
  const githubOAuth: GithubOAuthConfig | undefined =
    clientId && clientSecret && stateSecret
      ? {
          clientId,
          clientSecret,
          stateSecret,
          redirectUri: env.MESH_GITHUB_REDIRECT_URI ?? `${publicBaseUrl}/v1/auth/github/callback`,
        }
      : undefined;

  const stripeKey = env.MESH_STRIPE_TEST_SECRET_KEY ?? env.STRIPE_TEST_SECRET_KEY;
  const stripe = stripeKey ? createStripeClient(stripeKey) : undefined;

  return {
    accounts,
    ledger,
    publicBaseUrl,
    dataDir,
    ...(githubOAuth === undefined ? {} : { githubOAuth }),
    ...(stripe === undefined ? {} : { stripe }),
    directDebitPaymentMethods: parseDirectDebitMethods(env.MESH_DIRECT_DEBIT_METHODS),
    ...(env.MESH_ADMIN_TOKEN ? { adminToken: env.MESH_ADMIN_TOKEN } : {}),
    defaultFeePercent: Number(env.MESH_FEE_PERCENT ?? 1),
  };
}
