/**
 * The weekly report as one small HTML page: the plain part first, the detail
 * below. Self-contained: no external asset, no script, no link out, so it
 * opens from a file, works offline and sends nothing anywhere. Light and
 * dark follow the reader's system setting. Readable on a phone.
 *
 * Pure: a report in, a string out. Every value is escaped; the page holds
 * what the report holds (money, counts, dates, and lever names and model ids
 * in the detail) and nothing else.
 */
import {
  count,
  money,
  reportHeadline,
  reportMonthLine,
  reportPointers,
  type Report,
  type VerifiedReport,
} from "./report.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{color-scheme:light dark;
  --bg:#FAFAF9;--paper:#FFFFFF;--ink:#0B0F14;--muted:#5B6472;--line:#E5E7EB;--accent:#1D4ED8;--soft:#EEF3FE;--warn:#B45309}
@media (prefers-color-scheme:dark){:root{
  --bg:#0B0F14;--paper:#131A23;--ink:#EEF1F5;--muted:#9BA6B5;--line:#252E3A;--accent:#8FB4FF;--soft:#172238;--warn:#F2B25C}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;padding:32px 16px 48px}
main{max-width:640px;margin:0 auto}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:26px 24px;margin-bottom:16px}
.eyebrow{font-size:14px;color:var(--muted);margin:0 0 10px;letter-spacing:.01em}
h1{font-size:clamp(28px,7.2vw,40px);line-height:1.12;letter-spacing:-.02em;margin:0 0 18px;font-weight:750;text-wrap:balance}
h1 .n{color:var(--accent);white-space:nowrap}
h2{font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:0 0 12px}
p{margin:0 0 8px}
.rows{margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}
.rows li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
.rows .v{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
.rows .keep{font-weight:750}
.rows .keep .v{color:var(--accent)}
.foot{color:var(--muted);font-size:15px;margin-top:14px}
.theo{background:var(--soft);border-color:transparent}
.theo p:last-child,.month p:last-child{margin-bottom:0}
.next{color:var(--muted);font-size:15px}
code{font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:2px 6px;border-radius:6px;white-space:nowrap}
.scroll{overflow-x:auto;margin:0 -4px 18px;padding:0 4px}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:13px}
td.r,th.r{text-align:right;padding-right:0}
.notes{margin:0;padding-left:18px;color:var(--muted);font-size:14px}
.notes li{margin-bottom:6px}
.tag{color:var(--muted);font-size:12px}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:22px}
`;

/** The one sentence the page leads with, with the amount picked out. */
function leadSentence(report: Report): string {
  if (!report.ledgerVerified) return "Mesh could not verify your ledger, so there is no figure.";
  const span = `this ${report.kind}`;
  if (report.case === "no_requests") return `Mesh saw no requests ${span}.`;
  if (report.case === "saved_nothing") return `Mesh saved you <span class="n">$0.00</span> ${span}.`;
  if (report.case === "cost_more") return `Mesh cost you <span class="n">${esc(money(Math.abs(report.savedUsd)))}</span> ${span}.`;
  return `Mesh saved you <span class="n">${esc(money(report.savedUsd))}</span> ${span}.`;
}

function moneyRows(report: VerifiedReport): string {
  const row = (label: string, value: string, cls = ""): string =>
    `<li${cls === "" ? "" : ` class="${cls}"`}><span>${esc(label)}</span><span class="v">${esc(value)}</span></li>`;
  if (report.case === "saved") {
    return `<ul class="rows">${[
      row("You paid your provider", money(report.paidProviderUsd)),
      row("Without Mesh", money(report.withoutMeshUsd)),
      row("Mesh saved you", money(report.savedUsd)),
      row("Mesh's fee on that", report.feeBelowOneCent ? "under one cent, nothing owed" : money(report.feeUsd)),
      row("You keep", money(report.keepUsd), "keep"),
    ].join("")}</ul>`;
  }
  return `<ul class="rows">${[
    row("You paid your provider", money(report.paidProviderUsd)),
    row("You owe Mesh", "nothing"),
  ].join("")}</ul>`;
}

const usd4 = (amount: number): string => money(amount, 4);

function detailSection(report: Report): string {
  if (!report.ledgerVerified || report.case === "no_requests") return "";
  const detail = report.detail;
  const parts: string[] = [];
  parts.push(`<h2>The detail</h2>`);
  parts.push(`<p class="next">${esc(report.period.kind === "week"
    ? `${report.period.startDate} to ${report.period.endDate}, in your time zone (${report.period.timeZone}).`
    : `${report.period.label}, the billing month (a calendar month in UTC).`)} Amounts are US dollars.</p>`);
  if (detail.levers.length > 0) {
    parts.push(`<p><strong>Where the saving came from</strong></p><div class="scroll"><table><thead><tr><th>Lever</th><th class="r">Requests</th><th class="r">Verified saving</th></tr></thead><tbody>${
      detail.levers.map((lever) => {
        const marks = [
          ...(lever.basis === "estimated-baseline" ? ["estimated baseline"] : []),
          ...(lever.provenByTheo === true ? ["proved by Theo"] : []),
        ];
        return `<tr><td>${esc(lever.lever)}${marks.length === 0 ? "" : ` <span class="tag">(${esc(marks.join("; "))})</span>`}</td>` +
          `<td class="r">${esc(count(lever.requests))}</td><td class="r">${esc(usd4(lever.savedUsd))}</td></tr>`;
      }).join("")
    }</tbody></table></div>`);
  }
  if (detail.models.length > 0) {
    parts.push(`<p><strong>By model</strong></p><div class="scroll"><table><thead><tr><th>Model</th><th class="r">Requests</th><th class="r">You paid</th><th class="r">Verified saving</th></tr></thead><tbody>${
      detail.models.map((model) =>
        `<tr><td>${esc(`${model.provider}/${model.model}`)}</td><td class="r">${esc(count(model.requests))}</td>` +
        `<td class="r">${esc(usd4(model.paidProviderUsd))}</td><td class="r">${esc(usd4(model.savedUsd))}</td></tr>`).join("")
    }</tbody></table></div>`);
  }
  const requestRows: [string, string][] = [
    [`Requests this ${report.kind}`, count(detail.requests.counted)],
    ["With a verified saving", count(detail.requests.withBilledSaving)],
    ["Part of a failed task (savings not counted)", count(detail.requests.excludedFailedTask)],
    ["On a model not in the price list (not counted)", count(detail.requests.unpriced)],
    ["Savings you already had (your own caching), not counted", usd4(detail.alreadyYoursUsd)],
  ];
  parts.push(`<p><strong>Requests</strong></p><div class="scroll"><table><tbody>${
    requestRows.map(([label, value]) => `<tr><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`).join("")
  }</tbody></table></div>`);
  if (detail.pieces.length > 1) {
    parts.push(`<p><strong>By billing month</strong></p><div class="scroll"><table><thead><tr><th>Month</th><th class="r">Requests</th><th class="r">You paid</th><th class="r">Verified saving</th></tr></thead><tbody>${
      detail.pieces.map((piece) =>
        `<tr><td>${esc(piece.billingMonth)}</td><td class="r">${esc(count(piece.requests))}</td>` +
        `<td class="r">${esc(usd4(piece.paidProviderUsd))}</td><td class="r">${esc(usd4(piece.savedUsd))}</td></tr>`).join("")
    }</tbody></table></div>`);
  }
  parts.push(`<ul class="notes">${detail.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>`);
  return `<section class="card">${parts.join("")}</section>`;
}

/** Turn "… : mesh some command" at the end of a line into the sentence plus the command set as code. */
function withCommand(line: string): string {
  const match = /^(.*?)(mesh [a-z][a-z0-9 <>.-]*)$/.exec(line);
  if (match === null) return esc(line);
  return `${esc(match[1]!)}<code>${esc(match[2]!)}</code>`;
}

/** The whole page. */
export function renderReportHtml(report: Report): string {
  const headline = reportHeadline(report);
  const title = report.kind === "week" ? `Mesh, your week (${report.period.label})` : `Mesh, your month (${report.period.label})`;
  const eyebrow = `Mesh · your ${report.kind}${report.period.finished ? "" : " so far"} · ${report.period.label}${report.period.finished ? "" : " · not finished"}`;

  const main: string[] = [];
  main.push(`<p class="eyebrow">${esc(eyebrow)}</p>`);
  main.push(`<h1>${leadSentence(report)}</h1>`);
  if (!report.ledgerVerified || report.case === "no_requests") {
    // The whole message is the two headline sentences; the first is the lead above.
    for (const line of headline.slice(1)) main.push(`<p>${withCommand(line)}</p>`);
    if (report.ledgerVerified && report.period.finished) {
      main.push(`<p class="next">No requests reached Mesh, so it is not connected to the tools you use.</p>`);
    }
  } else {
    main.push(moneyRows(report));
    if (report.case === "saved_nothing") main.push(`<p class="foot">Your setup is already lean.</p>`);
    if (report.case === "cost_more") main.push(`<p class="foot">That counts against Mesh's fee.</p>`);
    main.push(`<p class="foot">${esc(`${count(report.requests)} ${report.requests === 1 ? "request" : "requests"}, ledger verified.`)}` +
      `${report.unpricedRequests === 0 ? "" : ` ${esc(headline[headline.length - 1]!)}`}</p>`);
  }

  const sections: string[] = [`<section class="card">${main.join("")}</section>`];
  if (report.theo !== null && report.theo.lines.length > 0) {
    sections.push(`<section class="card theo"><h2>Theo</h2>${report.theo.lines.map((line) => `<p>${withCommand(line)}</p>`).join("")}</section>`);
  }
  const monthLine = reportMonthLine(report);
  const pointers = reportPointers(report, { detailShown: true });
  if (monthLine !== undefined || pointers.length > 0) {
    sections.push(`<section class="card month">${[
      ...(monthLine === undefined ? [] : [`<h2>This month so far</h2><p>${esc(monthLine.replace(/^This month so far \(([^)]*)\): /, "$1: "))}</p>`]),
      ...pointers.map((line) => `<p class="next">${withCommand(line)}</p>`),
    ].join("")}</section>`);
  }
  sections.push(detailSection(report));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${sections.filter((section) => section !== "").join("\n")}
<footer>Made on this computer by Mesh, from your own ledger. Nothing was sent anywhere.<br>Written ${esc(report.generatedAt.slice(0, 16).replace("T", " "))} UTC. The latest: <code>mesh report</code></footer>
</main>
</body>
</html>
`;
}
