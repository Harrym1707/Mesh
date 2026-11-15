import {
  recomputeInvoice,
  verifyLedgerChain,
  type Invoice,
  type LedgerRecord,
} from "../../core/dist/src/index.js";

/**
 * The customer-facing monthly statement: one self-contained HTML page
 * rendered from the customer's own ledger spools.
 *
 * This is the invoice as MESH means it: every figure on the page is the
 * output of `recomputeInvoice` over records the customer holds, the chain
 * verification status is printed at the top (a broken chain renders DO NOT
 * PAY, not a number), exclusions and unbilled levers are itemised rather
 * than hidden, negative levers appear as negative, estimates carry their
 * label, and the command to recompute everything independently is printed
 * on the statement itself. No network access, no external assets.
 */

export type LedgerReportSpool = {
  /** Display name, usually the spool filename. */
  name: string;
  records: readonly LedgerRecord[];
};

export type LedgerReportOptions = {
  /** Restrict to one invoice period (YYYY-MM). Omitted: all events. */
  period?: string;
  /** MESH's contracted share of net verified savings. Default 1 (percent). */
  feePercent?: number;
  /**
   * Verified-savings deficit carried in from prior statements (cumulative
   * netting: fees never exceed aggregate verified savings). Applied at the
   * statement total, shown as its own line.
   */
  carryForwardDeficitUsd?: number;
  /** Timestamp printed on the statement; injectable for deterministic tests. */
  generatedAt?: string;
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const usd = (value: number): string => {
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(4)}`;
};

type SpoolSection = {
  name: string;
  chainOk: boolean;
  chainDetail: string;
  invoice: Invoice;
  spendUsd: number;
  pricedEvents: number;
  waste: { inspected: number; reEmitted: number; reEmittedCode: number; duplicates: number };
};

function sectionOf(spool: LedgerReportSpool, options: LedgerReportOptions): SpoolSection {
  const chain = verifyLedgerChain(spool.records);
  const events = spool.records.map((record) => record.event);
  const inPeriod = options.period === undefined
    ? events
    : events.filter((event) => event.invoicePeriod === options.period);
  const invoice = recomputeInvoice(events, {
    ...(options.period === undefined ? {} : { period: options.period }),
    feePercent: options.feePercent ?? 1,
  });
  let spendUsd = 0;
  let pricedEvents = 0;
  const waste = { inspected: 0, reEmitted: 0, reEmittedCode: 0, duplicates: 0 };
  for (const event of inPeriod) {
    if (typeof event.actualUsd === "number") {
      spendUsd += event.actualUsd;
      pricedEvents += 1;
    }
    if (event.outputDiagnostics !== undefined) {
      waste.inspected += event.outputDiagnostics.inspectedOutputTokens;
      waste.reEmitted += event.outputDiagnostics.reEmittedOutputTokens;
      waste.reEmittedCode += event.outputDiagnostics.reEmittedCodeTokens;
    }
    if (event.duplicateOfRequestId !== undefined) waste.duplicates += 1;
  }
  return {
    name: spool.name,
    chainOk: chain.ok,
    chainDetail: chain.ok
      ? `${chain.length} record(s), every hash links`
      : `broken at seq ${chain.seq}: ${chain.reason}`,
    invoice,
    spendUsd,
    pricedEvents,
    waste,
  };
}

export function renderLedgerReport(
  spools: readonly LedgerReportSpool[],
  options: LedgerReportOptions = {},
): string {
  const feePercent = options.feePercent ?? 1;
  const sections = spools.map((spool) => sectionOf(spool, options));
  const allChainsOk = sections.every((section) => section.chainOk);
  const totalSpend = sections.reduce((sum, section) => sum + section.spendUsd, 0);
  const totalSavings = sections.reduce((sum, section) => sum + section.invoice.netVerifiedSavingsUsd, 0);
  const carryIn = options.carryForwardDeficitUsd ?? 0;
  const netAfterCarry = totalSavings - carryIn;
  const carryOut = Math.max(0, -netAfterCarry);
  const totalDue = allChainsOk && Math.round(netAfterCarry * 100) > 0
    ? (netAfterCarry * feePercent) / 100
    : 0;
  const periodLabel = options.period ?? "all recorded periods";
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const sectionHtml = sections.map((section) => {
    const inv = section.invoice;
    const lines = inv.lineItems.map((line) => `
      <tr>
        <td>${escapeHtml(line.leverId)}${line.basis === "estimated-baseline" ? ' <span class="tag">estimated-baseline</span>' : ""}${line.kind === "lossy" ? ' <span class="tag gate">gate-approved</span>' : ""}</td>
        <td class="num">${line.events}</td>
        <td class="num ${line.savedUsd < 0 ? "neg" : ""}">${usd(line.savedUsd)}</td>
      </tr>`).join("");
    const unbilled = inv.recordedUnbilled.map((item) => `
      <tr class="muted"><td>${escapeHtml(item.leverId)} — ${escapeHtml(item.reason)}</td><td class="num">${item.events}</td><td class="num">not billed</td></tr>`).join("");
    const excluded = inv.excludedAlreadyOwned;
    const excludedRows = [
      ["your own provider-cache savings", excluded.providerCacheOnAppendedHistoryUsd],
      ["your own gateway-cache savings", excluded.gatewayCacheUsd],
    ].filter(([, value]) => (value as number) !== 0).map(([label, value]) => `
      <tr class="muted"><td>${label} — excluded, never billed</td><td class="num"></td><td class="num">${usd(value as number)}</td></tr>`).join("");
    return `
  <section>
    <h2>${escapeHtml(section.name)}</h2>
    <p class="chain ${section.chainOk ? "ok" : "bad"}">hash chain ${section.chainOk ? "VERIFIED" : "BROKEN"} — ${escapeHtml(section.chainDetail)}</p>
    <p class="meta">${inv.eventsConsidered} event(s) in period · ${section.pricedEvents} priced · ${inv.unpricedEvents} unpriced (never guessed)${inv.eventsExcludedForFailedTasks > 0 ? ` · ${inv.eventsExcludedForFailedTasks} excluded for failed tasks` : ""}</p>
    <table>
      <thead><tr><th>verified savings, by lever</th><th class="num">events</th><th class="num">USD</th></tr></thead>
      <tbody>${lines || '<tr class="muted"><td colspan="3">no billable savings in this period</td></tr>'}${unbilled}${excludedRows}</tbody>
      <tfoot><tr><td>net verified savings — spend ${usd(section.spendUsd)}</td><td></td><td class="num ${inv.netVerifiedSavingsUsd < 0 ? "neg" : ""}">${usd(inv.netVerifiedSavingsUsd)}</td></tr></tfoot>
    </table>
    ${section.waste.inspected > 0 || section.waste.duplicates > 0 ? `<p class="meta">output waste observed (measured, not billed): ${section.waste.reEmitted.toLocaleString("en-US")} of ${section.waste.inspected.toLocaleString("en-US")} inspected output tokens (${section.waste.inspected > 0 ? Math.round((section.waste.reEmitted / section.waste.inspected) * 100) : 0}%) re-emit text already in the request${section.waste.reEmittedCode > 0 ? `, ${Math.round((section.waste.reEmittedCode / Math.max(1, section.waste.reEmitted)) * 100)}% of it code` : ""}${section.waste.duplicates > 0 ? ` · ${section.waste.duplicates} byte-identical retried request(s)` : ""} — a diff-shaped integration would reclaim part of this.</p>` : ""}
  </section>`;
  }).join("\n");

  const verdictLine = !allChainsOk
    ? "DO NOT PAY — a ledger chain failed verification. A statement over an unverifiable ledger is not an invoice."
    : Math.round(netAfterCarry * 100) > 0
      ? `Amount due: ${usd(totalDue)} (${feePercent}% of ${usd(netAfterCarry)} net verified savings${carryIn > 0 ? ` after ${usd(carryIn)} deficit carried in` : ""})`
      : carryOut > 0
        ? `Amount due: $0.0000 — do_not_charge. ${usd(carryOut)} deficit carries forward: future fees apply only after it is recovered.`
        : "Amount due: $0.0000 — do_not_charge. A period that saved nothing bills nothing.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MESH statement — ${escapeHtml(periodLabel)}</title>
<style>
:root{--bg:#F1F7FB;--ink:#102A43;--muted:#486581;--ocean:#2864A5;--line:#d9e6f0;--paper:#ffffff;--neg:#B3261E}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 Manrope,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
main{max-width:720px;margin:0 auto;padding:40px 20px 64px}
header{border-bottom:3px solid var(--ocean);padding-bottom:16px;margin-bottom:8px}
h1{font-size:26px;margin:0;letter-spacing:-.02em}
h2{font-size:15px;margin:28px 0 4px;color:var(--ocean)}
.meta{color:var(--muted);font-size:13px;margin:2px 0 8px}
.chain{font-size:13px;font-weight:700;margin:2px 0}
.chain.ok{color:#1b7f4b}.chain.bad{color:var(--neg)}
table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);font-size:13.5px}
th{background:#e4f4fd;font-weight:700}
tfoot td{font-weight:800;border-bottom:none;background:#f7fbfe}
.num{text-align:right;white-space:nowrap}
.neg{color:var(--neg)}
.muted td{color:var(--muted)}
.tag{font-size:10.5px;background:#e4f4fd;color:var(--ocean);border-radius:4px;padding:1px 6px;font-weight:700}
.tag.gate{background:#e8f6ee;color:#1b7f4b}
.due{margin-top:28px;background:var(--ink);color:#F1F7FB;border-radius:10px;padding:18px 20px;font-size:17px;font-weight:800}
.due.zero{background:var(--ocean)}
.due.bad{background:var(--neg)}
footer{margin-top:28px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
code{background:#e8f1f8;padding:1px 5px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<main>
<header>
  <h1>MESH statement</h1>
  <p class="meta">period: ${escapeHtml(periodLabel)} · generated ${escapeHtml(generatedAt)} · fee ${feePercent}% of verified savings — nothing else</p>
</header>
${sectionHtml}
<div class="due ${!allChainsOk ? "bad" : Math.round(totalSavings * 100) > 0 ? "" : "zero"}">${escapeHtml(verdictLine)}</div>
<p class="meta">total spend across spools ${usd(totalSpend)} · total net verified savings ${usd(totalSavings)}</p>
<footer>
Every figure on this statement is recomputed from ledger files on YOUR machine —
usage numbers from the provider's own responses, never prompt content. Verify it
independently, without MESH and without accepting any terms:
<code>npx -y -p @harrym1707/verify mesh-verify &lt;spool.jsonl&gt;</code> — if your
recomputation disagrees with this statement, yours wins. Negative levers are
shown negative and reduce the bill; savings you already had are itemised above
and never billed. Methodology: https://www.mesh-technology.com/methodology.html<br>
MESH is a trading name of Flux AI Technologies Limited, registered in England and Wales, company no. 17543982.
</footer>
</main>
</body>
</html>
`;
}
