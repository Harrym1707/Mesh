import type { PublicAccount } from "../../../packages/core/dist/src/index.js";

/**
 * The claim-result page: the one screen a developer sees after GitHub sign-in.
 * It shows the Mesh account key EXACTLY ONCE (only when a key is present, i.e.
 * right after it was minted), with the single command that points a proxy or
 * SDK at the account. No styling framework, no scripts — inline CSS only, same
 * spirit as the existing dashboard.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type ClaimView = {
  account: PublicAccount;
  apiBaseUrl: string;
  /** Present ONLY immediately after the key was minted; shown once, never stored. */
  accountKey?: string;
  /** Link that reissues (rotates) the key for a returning user who lost theirs. */
  reissueUrl?: string;
};

export function claimPageHtml(view: ClaimView): string {
  const { account, apiBaseUrl, accountKey, reissueUrl } = view;
  const keyBlock = accountKey
    ? `
    <section class="key">
      <h2>Your Mesh account key</h2>
      <p class="warn">Shown once. Copy it now — Mesh stores only a hash and can never show it again.</p>
      <pre id="key">${escapeHtml(accountKey)}</pre>
      <h3>Point your proxy or SDK at this account</h3>
      <pre>export MESH_API_URL=${escapeHtml(apiBaseUrl)}
export MESH_ACCOUNT_KEY=${escapeHtml(accountKey)}</pre>
      <p>Your <strong>provider</strong> API key still only passes through Mesh — it is never stored. This Mesh account key only authenticates your metering.</p>
    </section>`
    : `
    <section class="key">
      <h2>Welcome back, ${escapeHtml(account.githubLogin)}</h2>
      <p>Your account key is <code>${escapeHtml(account.accountKeyPrefix)}…</code> It is shown only at creation.</p>
      ${reissueUrl ? `<p>Lost it? <a href="${escapeHtml(reissueUrl)}">Reissue a new key</a> (this invalidates the old one).</p>` : ""}
    </section>`;

  const paymentBlock = account.paymentChoice
    ? `<p>Payment: <strong>${escapeHtml(account.paymentChoice.replace("_", " "))}</strong>${
        account.directDebitMandateStatus ? ` (mandate ${escapeHtml(account.directDebitMandateStatus)})` : ""
      }</p>`
    : `<p>Next: choose how you pay the ${account.feePercent}% fee on verified savings — direct debit or bank transfer — with:</p>
       <pre>curl -s ${escapeHtml(apiBaseUrl)}/v1/account/payment-choice \\
  -H "authorization: Bearer $MESH_ACCOUNT_KEY" \\
  -H "content-type: application/json" \\
  -d '{"choice":"direct_debit"}'</pre>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mesh — claim your savings</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.2rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
  pre { background: rgba(127,127,127,.12); padding: .9rem 1rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .warn { color: #b9471a; font-weight: 600; }
  .mark { letter-spacing: .04em; opacity: .7; }
  footer { margin-top: 2.5rem; opacity: .6; font-size: .85rem; }
</style></head>
<body>
  <p class="mark">⬢ MESH</p>
  <h1>Your account is live</h1>
  <p>Signed in as <strong>${escapeHtml(account.githubLogin)}</strong>${account.email ? ` · ${escapeHtml(account.email)}` : ""}. Account id <code>${escapeHtml(account.id)}</code>.</p>
  ${keyBlock}
  <section>
    <h2>Billing</h2>
    ${paymentBlock}
    <p>Mesh charges ${account.feePercent}% of <em>verified</em> savings. If a period saved nothing, the invoice says do-not-charge and you owe nothing — recompute every figure yourself from your hash-chained ledger.</p>
  </section>
  <footer>Mesh meters usage-derived numbers only. No prompt content is ever read, stored, or sent.</footer>
</body></html>`;
}
