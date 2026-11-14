/**
 * The savings CTA — the moment the product asks for the signup.
 *
 * MESH already computes a verified savings number from a hash-chained ledger
 * the customer holds. This module turns that number into (a) a console call to
 * action a runner can print on exit, and (b) a paste-able README badge, so the
 * person running MESH self-identifies and the badge carries MESH into their
 * repo. Everything here is honest: when the ledger says `do_not_charge`, the
 * CTA says so and asks for nothing.
 *
 * This module is intentionally dependency-free (pure string/number logic) so
 * both the SDK and the `mesh` CLI can import it directly without pulling the
 * billing engine into their bundles. The core-dependent readers that build a
 * {@link SavingsSnapshot} from a ledger spool live in `./savings-snapshot.js`.
 */

/** Where a developer running MESH goes to claim their verified savings. */
export const MESH_SIGNUP_URL = "https://www.mesh-technology.com";

export type SavingsSnapshot = {
  /** Requests metered across every spool read. */
  requests: number;
  /** Net verified savings in USD (from provider usage, never an estimate). */
  savedUsd: number;
  /** What the metered traffic actually cost at the provider, in USD. */
  spendUsd: number;
  /** "charge" when MESH saved money; "do_not_charge" when it did not. */
  verdict: "charge" | "do_not_charge";
  /** False when any spool's hash chain failed to verify. */
  chainOk: boolean;
};

/**
 * Savings as a percentage of the un-reduced baseline (actual paid + saved),
 * matching the README's "% lower cost" framing. Null when there is no spend to
 * compare against.
 */
export function savingsPercent(snap: Pick<SavingsSnapshot, "savedUsd" | "spendUsd">): number | null {
  const baseline = snap.spendUsd + snap.savedUsd;
  if (baseline <= 0) return null;
  return (snap.savedUsd / baseline) * 100;
}

export type SavingsCtaOptions = {
  /** Where to claim savings; defaults to {@link MESH_SIGNUP_URL}. */
  signupUrl?: string;
  /** Branding prefix on each line; defaults to "⬢ MESH". */
  mark?: string;
};

/**
 * The console CTA. Honest by construction: a broken chain reports nothing, an
 * empty spool invites a first request, a `do_not_charge` verdict asks for
 * nothing, and only a real verified saving makes the ask.
 */
export function formatSavingsCta(snap: SavingsSnapshot, opts: SavingsCtaOptions = {}): string {
  const mark = opts.mark ?? "⬢ MESH";
  const url = opts.signupUrl ?? MESH_SIGNUP_URL;

  if (!snap.chainOk) {
    return `${mark}: a ledger spool failed to verify — savings withheld. Recompute with \`mesh verify\`.`;
  }
  if (snap.requests === 0) {
    return `${mark}: no requests metered yet. Point a client's base_url here and your verified savings print on exit.`;
  }
  if (snap.verdict === "do_not_charge" || snap.savedUsd <= 0) {
    return [
      `${mark}: ${snap.requests} requests metered · verified savings $${snap.savedUsd.toFixed(4)}.`,
      `Your stack is already lean — verdict do_not_charge. You owe MESH nothing.`,
      `Recompute it yourself: \`mesh verify\`.`,
    ].join("\n");
  }

  const pct = savingsPercent(snap);
  const pctText = pct === null ? "" : ` (${pct.toFixed(1)}% lower)`;
  return [
    ``,
    `${mark} saved you $${snap.savedUsd.toFixed(4)}${pctText} across ${snap.requests} verified requests.`,
    `This number is a pure function of a hash-chained ledger you hold — recompute it: \`mesh verify\`.`,
    `Claim your savings and keep them metered: ${url}`,
    ``,
  ].join("\n");
}

export type SavingsBadge = {
  /** The shields.io image URL. */
  imageUrl: string;
  /** A ready-to-paste markdown image link to the signup page. */
  markdown: string;
};

/**
 * A paste-able README badge reflecting this spool's verified savings. Every
 * user who adds it carries MESH into their repo — the distribution loop.
 */
export function savingsBadge(
  snap: SavingsSnapshot,
  opts: { signupUrl?: string } = {},
): SavingsBadge {
  const url = opts.signupUrl ?? MESH_SIGNUP_URL;
  const pct = savingsPercent(snap);

  let message: string;
  let color: string;
  if (!snap.chainOk) {
    message = "unverified";
    color = "lightgrey";
  } else if (snap.verdict === "do_not_charge" || snap.savedUsd <= 0) {
    message = "already lean";
    color = "blue";
  } else {
    message = pct === null ? `$${snap.savedUsd.toFixed(2)} saved` : `${pct.toFixed(0)}% lower`;
    color = "brightgreen";
  }

  const imageUrl =
    `https://img.shields.io/static/v1?label=${encodeURIComponent("LLM cost")}` +
    `&message=${encodeURIComponent(message)}&color=${color}`;
  return {
    imageUrl,
    markdown: `[![LLM cost reduced by MESH](${imageUrl})](${url})`,
  };
}
