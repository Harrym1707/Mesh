/**
 * `mesh dashboard` — a live, local web view of what MESH is doing for you.
 *
 * Serves a self-contained page on 127.0.0.1 that polls a tiny JSON endpoint
 * every few seconds and shows your verified savings, the per-lever breakdown,
 * and what Theo is doing right now (which levers he's applying, and what he's
 * holding behind the replay-gate). It reads your own ledger at ~/.mesh/ledger
 * and your Theo policy — nothing leaves the machine, and the numbers match
 * `mesh verify` exactly because they are recomputed from the same ledger.
 *
 * The page carries the MESH brand: paper ground with the isometric dot-paper,
 * Manrope, the Mesh-blue accent and the hand-drawn squiggle, matching the site.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { recomputeInvoice } from "../../core/src/savings-ledger.js";
import { groupWorkflowSessions } from "../../core/src/workflow-sessions.js";
import { policyCoverage, withheldLevers } from "../../sdk-js/src/theo-policy.js";
import { defaultTheoMemoryPath, loadTheoMemory } from "../../sdk-js/src/theo-agent-store.js";
import { BUILD_COMMIT, DEFAULT_PORT, MESH_HOME, readLedger, readPolicy } from "./start.js";

type DashArgs = { port: number; proxyPort: number; ledgerDir: string; open: boolean };

function parseArgs(argv: string[]): DashArgs {
  const args: DashArgs = { port: 8799, proxyPort: DEFAULT_PORT, ledgerDir: join(MESH_HOME, "ledger"), open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key === "--help" || key === "-h") {
      console.log(
        `Usage: mesh dashboard [options]\n\n` +
          `  --port <n>        Port for the dashboard (default 8799).\n` +
          `  --proxy-port <n>  Proxy port to show as up/down (default ${DEFAULT_PORT}).\n` +
          `  --ledger <dir>    Ledger to read (default ~/.mesh/ledger).\n` +
          `  --no-open         Don't open a browser; just print the URL.\n` +
          `  --help            Show this message.`,
      );
      process.exit(0);
    }
    if (key === "--no-open") { args.open = false; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    i += 1;
    if (key === "--port") args.port = Number.parseInt(value, 10);
    else if (key === "--proxy-port") args.proxyPort = Number.parseInt(value, 10);
    else if (key === "--ledger") args.ledgerDir = value;
    else throw new Error(`Unknown option: ${key}. See mesh dashboard --help.`);
  }
  return args;
}

function proxyUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(400, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
}

async function buildData(args: DashArgs): Promise<unknown> {
  const { records, chainOk, brokenAt } = readLedger(args.ledgerDir);
  const invoice = records.length ? recomputeInvoice(records.map((r) => r.event)) : null;
  const policy = readPolicy();
  const active = (policy.levers ?? []).map((l) => ({ lever: l.lever, class: l.class }));
  // Theo's memory (proposals awaiting approval, levers auto-rolled-back on drift)
  // lives beside the ledger; absent until Theo has run at least once.
  const memory = loadTheoMemory(defaultTheoMemoryPath(args.ledgerDir, "local"));
  return {
    build: BUILD_COMMIT,
    updatedAt: new Date().toISOString(),
    chainOk,
    brokenAt: brokenAt ?? null,
    proxyUp: await proxyUp(args.proxyPort),
    savings: invoice
      ? {
          netUsd: invoice.netVerifiedSavingsUsd,
          verdict: invoice.verdict,
          eventsConsidered: invoice.eventsConsidered,
          eventsBilled: invoice.eventsBilled,
          unpricedEvents: invoice.unpricedEvents,
        }
      : { netUsd: 0, verdict: "do_not_charge", eventsConsidered: 0, eventsBilled: 0, unpricedEvents: 0 },
    lineItems: invoice?.lineItems ?? [],
    recordedUnbilled: invoice?.recordedUnbilled ?? [],
    // Theo's activity broken out per working session (grouped by app + activity
    // gaps; see groupWorkflowSessions). Capped so the page stays light.
    workflows: records.length ? groupWorkflowSessions(records.map((r) => r.event), { limit: 12 }) : [],
    theo: {
      qualityCeilingPercent: policy.qualityCeilingPercent,
      active,
      withheld: withheldLevers(policy),
      coverage: policyCoverage(policy),
      proposals: memory?.proposals ?? [],
      rolledBack: memory?.rolledBack ?? [],
    },
  };
}

export async function runDashboard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/data") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(await buildData(args)));
        return;
      }
      if (req.url === "/" || req.url === "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
        return;
      }
      res.writeHead(404); res.end("not found");
    } catch (error) {
      res.writeHead(500); res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(args.port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(`\n  MESH dashboard  ·  ${url}`);
  console.log(`  Live view of your verified savings and what Theo is doing. Ctrl+C to stop.\n`);
  if (args.open) openBrowser(url);
  const shutdown = (): void => { server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref(); }
  catch { /* headless or no browser — the URL is printed */ }
}

// Self-contained, on-brand page: MESH paper ground + dot-paper + Manrope +
// Mesh-blue accent + the squiggle. Inline only — no external requests, so it
// works offline and nothing leaves the machine.
const SQUIGGLE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 10'%3E%3Cpath d='M0 5 q6 -4 12 0 t12 0 t12 0 t12 0 t12 0 t12 0' fill='none' stroke='%232563EB' stroke-width='1.6' opacity='.7'/%3E%3C/svg%3E";
const DOTS = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='59'%3E%3Cg fill='%230B0F14' fill-opacity='0.05'%3E%3Ccircle cx='0' cy='0' r='1.1'/%3E%3Ccircle cx='34' cy='0' r='1.1'/%3E%3Ccircle cx='0' cy='59' r='1.1'/%3E%3Ccircle cx='34' cy='59' r='1.1'/%3E%3Ccircle cx='17' cy='29.5' r='1.1'/%3E%3C/g%3E%3C/svg%3E";
const DOTS_GLOW = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='59'%3E%3Cg fill='%232563EB' fill-opacity='0.55'%3E%3Ccircle cx='0' cy='0' r='1.2'/%3E%3Ccircle cx='34' cy='0' r='1.2'/%3E%3Ccircle cx='0' cy='59' r='1.2'/%3E%3Ccircle cx='34' cy='59' r='1.2'/%3E%3Ccircle cx='17' cy='29.5' r='1.2'/%3E%3C/g%3E%3C/svg%3E";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mesh — live</title>
<style>
  :root{color-scheme:light;
    --bg:#FAFAF9;--ink:#0B0F14;--muted:#5B6472;--line:#E5E7EB;--accent:#2563EB;--ocean:#1D4ED8;
    --paper:#ffffff;--stone:#E7E5E4;--stone-line:#CFCAC3;--stone-muted:#57534E;--bad:#DC2626}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:40px 24px}
  .dotpaper{position:fixed;inset:0;z-index:0;pointer-events:none}
  .dotpaper .base,.dotpaper .glow{position:absolute;inset:0}
  .dotpaper .base{background:url("${DOTS}")}
  .dotpaper .glow{opacity:0;transition:opacity .4s ease;background:url("${DOTS_GLOW}");
    -webkit-mask-image:radial-gradient(circle 150px at var(--mx) var(--my),#000 0%,rgba(0,0,0,.35) 48%,transparent 72%);
    mask-image:radial-gradient(circle 150px at var(--mx) var(--my),#000 0%,rgba(0,0,0,.35) 48%,transparent 72%)}
  .dotpaper.lit .glow{opacity:1}
  @media (prefers-reduced-motion:reduce){.dotpaper .glow{display:none}}
  .wrap{max-width:900px;margin:0 auto;position:relative;z-index:1}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:22px}
  .mark{font-size:22px;font-weight:800;letter-spacing:-.02em}
  .mark .dot{color:var(--accent)}
  .mark .live{font-size:14px;font-weight:600;color:var(--muted);margin-left:8px;letter-spacing:0}
  .build{font-size:13px;color:var(--muted)}
  .hero{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:26px 28px 24px;margin-bottom:16px}
  .cap{font-size:14px;color:var(--muted)}
  .saved{font-size:clamp(46px,9vw,92px);font-weight:800;letter-spacing:-.04em;line-height:.95;color:var(--ocean);margin:4px 0 10px}
  .saved .cur{color:var(--accent)}
  .verdict{display:inline-block;font-size:13px;font-weight:700;padding:5px 13px;border-radius:999px}
  .verdict.charge{background:rgba(37,99,235,.12);color:var(--accent)}
  .verdict.do_not_charge{background:var(--stone);color:var(--stone-muted)}
  .events{font-size:14px;color:var(--muted);margin-left:12px}
  .grid{display:grid;grid-template-columns:1fr;gap:16px}@media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}
  .panel{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px}
  .panel h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:0 0 16px;position:relative;padding-bottom:11px}
  .panel h2::after{content:"";position:absolute;left:0;bottom:0;width:72px;height:9px;background:url("${SQUIGGLE}") left/contain no-repeat}
  .theo .hex{color:var(--accent);font-weight:800}
  .sub{font-size:13px;color:var(--muted);margin:0 0 7px}
  .chip{display:inline-block;font-size:13px;font-weight:600;padding:5px 12px;border-radius:999px;margin:0 6px 7px 0;background:#fff;border:1px solid var(--line)}
  .chip.on{border-color:var(--accent);color:var(--accent);background:rgba(37,99,235,.06)}
  .chip.on .k{color:var(--muted);font-weight:500}
  .chip.held{border-color:var(--stone-line);color:var(--stone-muted);background:var(--stone)}
  .chip.avail{border-style:dashed;border-color:var(--stone-line);color:var(--muted);background:#fff}
  .coverage{font-size:13.5px;color:var(--muted);line-height:1.4}
  .coverage .n{color:var(--ink);font-weight:800}
  .coverage .pct{color:var(--accent);font-weight:700}
  .meter{margin-top:9px;height:8px;border-radius:999px;background:var(--stone);overflow:hidden}
  .meter .fill{height:100%;width:0;background:var(--accent);border-radius:999px;transition:width .5s ease}
  .ceiling{font-size:13px;color:var(--muted);margin-top:14px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:600;font-size:13px}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td .k{color:var(--muted)}
  .empty{color:var(--muted);font-size:14px}
  .unbilled{font-size:13px;color:var(--muted);margin-top:12px;line-height:1.5}
  .foot{margin-top:18px;font-size:13px;color:var(--muted);display:flex;gap:18px;flex-wrap:wrap}
  .ind{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--stone-line)}
  .ind.ok{background:var(--accent)} .ind.bad{background:var(--bad)}
  .wfpanel{margin-top:16px}
  .wf{padding:12px 0;border-bottom:1px solid var(--line)}
  .wf:last-child{border-bottom:0}
  .wf-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .wf-when{font-weight:700;font-size:14.5px}
  .wf-saved{font-variant-numeric:tabular-nums;color:var(--ocean);font-weight:700}
  .wf-saved.zero{color:var(--muted);font-weight:500}
  .wf-meta{font-size:13px;color:var(--muted);margin:3px 0 8px}
  .wf-levers .chip{font-size:12px;padding:3px 9px;margin:0 5px 5px 0}
</style></head><body>
<div class="dotpaper" id="dp"><div class="base"></div><div class="glow"></div></div>
<div class="wrap">
  <header>
    <div class="mark">mesh<span class="dot">.</span><span class="live">live</span></div>
    <span class="build" id="build"></span>
  </header>
  <div class="hero">
    <div class="cap">Verified savings on your own traffic</div>
    <div class="saved" id="saved"><span class="cur">$</span>0.0000</div>
    <span class="verdict do_not_charge" id="verdict">—</span>
    <span class="events" id="events"></span>
  </div>
  <div class="grid">
    <div class="panel theo">
      <h2><span class="hex">⬢ Theo</span> — what he's doing</h2>
      <div class="coverage" id="coverage"></div>
      <div class="meter"><div class="fill" id="coverfill"></div></div>
      <p class="sub" style="margin-top:16px">Applying now</p>
      <div id="active"><span class="empty">—</span></div>
      <p class="sub" style="margin-top:14px">Held behind the replay-gate</p>
      <div id="withheld"><span class="empty">nothing held</span></div>
      <p class="sub" style="margin-top:14px">Not yet adopted</p>
      <div id="available"><span class="empty">—</span></div>
      <p class="sub" style="margin-top:14px">Awaiting your approval</p>
      <div id="proposals"><span class="empty">none</span></div>
      <p class="sub" style="margin-top:14px">Auto-rolled-back after drift</p>
      <div id="rolledback"><span class="empty">none</span></div>
      <div class="ceiling" id="ceiling"></div>
    </div>
    <div class="panel">
      <h2>Savings by lever</h2>
      <table><thead><tr><th>lever</th><th>kind</th><th class="num">events</th><th class="num">saved</th></tr></thead>
      <tbody id="levers"><tr><td colspan="4" class="empty">No billable savings yet.</td></tr></tbody></table>
      <div class="unbilled" id="unbilled"></div>
    </div>
  </div>
  <div class="panel wfpanel">
    <h2>Workflows — Theo per working session</h2>
    <p class="sub">Grouped by activity gaps and app. A working session, not a semantic task — the APIs carry no task id, so these are your runs of activity.</p>
    <div id="workflows"><span class="empty">No sessions yet — run Claude Code through MESH and this fills in.</span></div>
  </div>
  <div class="foot">
    <span id="proxy"><span class="ind bad"></span>proxy</span>
    <span id="chain"><span class="ind ok"></span>ledger</span>
    <span id="updated"></span>
  </div>
</div>
<script>
const $=(id)=>document.getElementById(id);
const usd=(n)=>Number(n||0).toFixed(4);
const dp=$('dp');
addEventListener('pointermove',(e)=>{dp.classList.add('lit');dp.style.setProperty('--mx',e.clientX+'px');dp.style.setProperty('--my',e.clientY+'px');});
function fmtRange(a,b){const o={month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};const sd=new Date(a).toLocaleString([],o);if(a===b)return sd;const et=new Date(b).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});return sd+' – '+et;}
function renderWf(w){
  const saved=Number(w.netVerifiedSavingsUsd||0);
  const status=w.failed?(w.succeeded+' ok, '+w.failed+' failed'):(w.requests+' request'+(w.requests===1?'':'s'));
  const app=(w.applicationId&&w.applicationId!=='proxy')?(' · '+w.applicationId):'';
  const models=(w.models||[]).join(', ');
  const levers=(w.levers&&w.levers.length)?w.levers.map(l=>'<span class="chip on">'+l.leverId+'<span class="k"> · $'+usd(l.savedUsd)+'</span></span>').join(''):'<span class="empty">no billable levers this session</span>';
  return '<div class="wf"><div class="wf-head"><span class="wf-when">'+fmtRange(w.startedAt,w.endedAt)+'</span><span class="wf-saved'+(saved>0?'':' zero')+'">$'+usd(saved)+' saved</span></div><div class="wf-meta">'+status+(models?' · '+models:'')+app+'</div><div class="wf-levers">'+levers+'</div></div>';
}
async function tick(){
  try{
    const d=await (await fetch('/data',{cache:'no-store'})).json();
    $('build').textContent='build '+d.build;
    $('saved').innerHTML='<span class="cur">$</span>'+usd(d.savings.netUsd);
    const v=$('verdict'); v.textContent=d.savings.verdict==='charge'?'billing':'do not charge'; v.className='verdict '+d.savings.verdict;
    $('events').textContent=d.savings.eventsConsidered+' requests'+(d.savings.unpricedEvents?(' · '+d.savings.unpricedEvents+' unpriced (recorded, not billed)'):'');
    const cov=d.theo.coverage;
    $('coverage').innerHTML='Theo is live on <span class="n">'+cov.activeCount+'</span> of <span class="n">'+cov.enforceableCount+'</span> levers he can enforce <span class="pct">('+cov.activeCoveragePercent.toFixed(0)+'%)</span> · '+cov.heldCount+' held · '+cov.availableCount+' not yet adopted';
    $('coverfill').style.width=cov.activeCoveragePercent.toFixed(1)+'%';
    const avail=cov.stands.filter(s=>s.state==='available');
    $('available').innerHTML=avail.length?avail.map(s=>'<span class="chip avail" title="Theo can enforce this; he has not adopted it for you yet.">'+s.label+'</span>').join(''):'<span class="empty">none — Theo has adopted every lever he can</span>';
    $('active').innerHTML=d.theo.active.length?d.theo.active.map(l=>'<span class="chip on">'+l.lever+'<span class="k"> · '+l.class+'</span></span>').join(''):'<span class="empty">none</span>';
    $('withheld').innerHTML=d.theo.withheld.length?d.theo.withheld.map(w=>'<span class="chip held" title="'+(w.reason||'')+'">'+w.lever+'</span>').join(''):'<span class="empty">nothing held</span>';
    $('proposals').innerHTML=(d.theo.proposals&&d.theo.proposals.length)?d.theo.proposals.map(p=>'<span class="chip held" title="'+(p.message||'')+'">'+p.lever+' · ~'+p.savingPercent.toFixed(1)+'%</span>').join(''):'<span class="empty">none</span>';
    $('rolledback').innerHTML=(d.theo.rolledBack&&d.theo.rolledBack.length)?d.theo.rolledBack.map(l=>'<span class="chip held">'+l+'</span>').join(''):'<span class="empty">none</span>';
    $('ceiling').textContent='Quality ceiling: '+d.theo.qualityCeilingPercent+'% — anything that could cost more than this stays off until a replay of your traffic proves it safe.';
    const rows=d.lineItems;
    $('levers').innerHTML=rows.length?rows.map(li=>'<tr><td>'+li.leverId+'</td><td class="k">'+li.kind+(li.basis?' · '+li.basis:'')+'</td><td class="num">'+li.events+'</td><td class="num">$'+usd(li.savedUsd)+'</td></tr>').join(''):'<tr><td colspan="4" class="empty">No billable savings yet — run Claude Code through MESH and this fills in.</td></tr>';
    $('unbilled').textContent=d.recordedUnbilled.length?('Also recorded (applied, never billed): '+d.recordedUnbilled.map(u=>u.leverId+' ×'+u.events).join(', ')):'';
    $('workflows').innerHTML=(d.workflows&&d.workflows.length)?d.workflows.map(renderWf).join(''):'<span class="empty">No sessions yet — run Claude Code through MESH and this fills in.</span>';
    $('proxy').innerHTML='<span class="ind '+(d.proxyUp?'ok':'bad')+'"></span>proxy '+(d.proxyUp?'up':'down');
    $('chain').innerHTML='<span class="ind '+(d.chainOk?'ok':'bad')+'"></span>ledger '+(d.chainOk?'verified':('BROKEN at '+d.brokenAt));
    $('updated').textContent='updated '+new Date(d.updatedAt).toLocaleTimeString();
  }catch(e){ $('updated').textContent='reconnecting…'; }
}
tick(); setInterval(tick,3000);
</script></body></html>`;
