import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "./context.js";
import { sendHtml, sendJson } from "./http-util.js";

/**
 * The claim bridge: GET /claim, the page MESH_SIGNUP_URL points at. It turns
 * the in-product "claim your savings" CTA into one click — sign in with GitHub,
 * land on the claim page with your Mesh account key and the single command that
 * points a proxy or SDK at your account. Agents can pass ?format=json to get
 * the start URL directly.
 */
export async function handleClaimRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServerContext,
): Promise<boolean> {
  if (req.method !== "GET" || url.pathname !== "/claim") return false;

  const startUrl = `${ctx.publicBaseUrl}/v1/auth/github/start`;
  const configured = ctx.githubOAuth !== undefined;

  if (url.searchParams.get("format") === "json") {
    sendJson(res, configured ? 200 : 501, configured ? { startUrl } : { error: "github_oauth_not_configured" });
    return true;
  }

  const cta = configured
    ? `<a class="btn" href="${startUrl}">Sign in with GitHub</a>`
    : `<p class="warn">Signup is not configured on this instance yet.</p>`;

  sendHtml(res, 200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mesh — claim your savings</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1.2rem; }
  h1 { font-size: 1.6rem; } .mark { letter-spacing: .04em; opacity: .7; }
  .btn { display: inline-block; margin: 1.2rem 0; padding: .7rem 1.1rem; border-radius: 8px; background: #111; color: #fff; text-decoration: none; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .btn { background: #fff; color: #111; } }
  .warn { color: #b9471a; font-weight: 600; }
  ol { padding-left: 1.2rem; } footer { margin-top: 2.5rem; opacity: .6; font-size: .85rem; }
</style></head>
<body>
  <p class="mark">⬢ MESH</p>
  <h1>Claim your verified savings</h1>
  <p>Mesh losslessly cuts your LLM cost and meters every dollar saved into a hash-chained ledger you can recompute yourself. Sign in once to start metering — then Mesh charges a small % of <em>verified</em> savings, and nothing if it saved you nothing.</p>
  ${cta}
  <ol>
    <li>Sign in with GitHub — your account is created instantly, no approval.</li>
    <li>Copy the one command that points your proxy or SDK at your account.</li>
    <li>Choose how you pay: direct debit, or an invoice you pay by bank transfer.</li>
  </ol>
  <footer>Your provider API key only ever passes through Mesh — never stored. No prompt content is ever read, stored, or sent.</footer>
</body></html>`);
  return true;
}
