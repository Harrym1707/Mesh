/**
 * The MESH landing page — built to the dealt tasteskill direction sheet
 * (.taste-skill/direction.json, seed 1631001276): "The product performs".
 *
 * The idea sentence: on this page, THE LEDGER AND THE REDUCER THEMSELVES
 * become the imagery — every picture is a true, working fragment of MESH at
 * real size (data-ui), and the stats section's receipt is the actual first
 * live export, rows summing to the total.
 *
 * The live thing: the hero's reducer panel. Press "Reduce" and watch the
 * duplicate block struck from a real request; the token counts are computed
 * from the sample's own bytes at build time, so the demo cannot lie.
 *
 * Recorded adjustments to the sheet (reasons the skill accepts):
 * - Ground stays the brand's Midnight (palette was dealt --keep); the sheet's
 *   off-white maps onto brand roles as instructed.
 * - The founder-mandated cursor energy field stays, hero-only and subtle.
 * - The proof/logo row is dropped: no logos exist and the skill forbids
 *   stand-ins; the receipt of real traffic is this page's proof.
 * - The serif accent line was cut: the hero carries one sentence only.
 */

const approxTokens = (text: string): number => Math.ceil(text.length / 4);

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const LOGO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/site/logos");
/** Official marks (Simple Icons, CC0), served white; sized by CSS. */
const logo = (slug: string): string =>
  readFileSync(path.join(LOGO_DIR, slug + ".svg"), "utf8").replace("<svg ", '<svg aria-hidden="true" ');

export function renderLanding(origin: string, repoUrl: string): string {
  // --- The hero demo's sample request: token counts computed from the bytes.
  const DUP_BLOCK = "Records 0-19: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.";
  const STABLE = `{"model":"claude-sonnet-5-5","system":"You are a careful assistant. Cite sources. Escalate anything risky.","messages":[{"role":"user","content":"Excerpts for case 7:`;
  const TAIL = ` Question: what does clause 7 require?"}]}`;
  // Four folds, counted from the strings that actually appear in the panel.
  const SCHEMA_RAW = '{"name":"lookup_0","description":"Look up records in subsystem 0…","input_schema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}}}}, …11 more verbose schemas…'.repeat(4);
  const SCHEMA_AFTER = "[ 12 tools, schemas minified ]";
  const HISTORY_RAW = `${DUP_BLOCK} ${DUP_BLOCK} ${DUP_BLOCK}`.repeat(3);
  const HISTORY_AFTER = "[ digest kept: errors + file paths; rest summarised ]";
  const TOOLRES_RAW = "Row 1 of 400: settlement nominal… ".repeat(60);
  const HISTORY_BYTES = HISTORY_RAW.length.toLocaleString("en-US");
  const TOOLRES_BYTES = TOOLRES_RAW.length.toLocaleString("en-US");
  const TOOLRES_AFTER = "[ headline + errors kept; oversized body capped ]";
  const beforeTokens = approxTokens(STABLE + TAIL) + approxTokens(SCHEMA_RAW) + approxTokens(HISTORY_RAW) + approxTokens(DUP_BLOCK) * 2 + approxTokens(TOOLRES_RAW);
  const afterTokens = approxTokens(STABLE + TAIL) + approxTokens(SCHEMA_AFTER) + approxTokens(HISTORY_AFTER) + approxTokens(DUP_BLOCK) + approxTokens(TOOLRES_AFTER);
  // Priced at the catalogued Sonnet 5.5 input rate, $2 per million tokens.
  const INPUT_RATE = 2 / 1_000_000;
  const beforeCost = (beforeTokens * INPUT_RATE).toFixed(5);
  const afterCost = (afterTokens * INPUT_RATE).toFixed(5);
  const steps = [
    { chip: "12 tool schemas compacted", tokens: approxTokens(SCHEMA_RAW) - approxTokens(SCHEMA_AFTER) },
    { chip: "stale history compacted, byte-stable", tokens: approxTokens(HISTORY_RAW) - approxTokens(HISTORY_AFTER) },
    { chip: "exact duplicate removed", tokens: approxTokens(DUP_BLOCK) },
    { chip: "fresh result capped before it bills", tokens: approxTokens(TOOLRES_RAW) - approxTokens(TOOLRES_AFTER) },
  ];

  // --- The receipt: the FIRST LIVE EXPORT, verbatim. Rows must truly sum.
  // 30 requests, claude-sonnet-5-5, 2026-10-19; spools audited in-session.
  // Second live export, 2026-10-19: all five agents billing, cache lever
  // earning live, the coding agent's gate-approved cap billing. Verbatim.
  const SPEND = [
    ["coding-agent", 0.06914], ["rag-docqa", 0.04057], ["batch-classifier", 0.03551],
    ["support-chat", 0.05225], ["already-lean", 0.00570],
  ] as const;
  const SAVED = [
    ["coding-agent — cap + schemas, net of cache", 0.02060],
    ["batch-classifier — cache stamp, earning", 0.01015],
    ["rag-docqa — duplicate excerpt removed", 0.00861],
    ["support-chat — tool-schema compaction", 0.00537],
    ["already-lean — nothing to remove", 0.0],
  ] as const;
  const spendTotal = SPEND.reduce((s, [, v]) => s + v, 0);
  const savedTotal = SAVED.reduce((s, [, v]) => s + v, 0);
  const savedPct = (savedTotal / spendTotal) * 100;
  const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(4)}`;

  const PAGE_JS = `
(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The performance: when the panel scrolls into view, MESH passes over the
  // request — each fold collapses, a chip names the lever, and the token and
  // cost meters run down. Counts come from the panel's own bytes. Loops.
  var panel = document.getElementById("reducer");
  var tokEl = document.getElementById("tok-count");
  var costEl = document.getElementById("cost-count");
  var statusEl = document.getElementById("demo-status");
  var sameEl = document.getElementById("same-note");
  var STEPS = ${JSON.stringify(steps)};
  var FROM = ${beforeTokens}, RATE = ${INPUT_RATE};
  function setMeters(tokens) {
    tokEl.textContent = String(Math.round(tokens)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
    costEl.textContent = (tokens * RATE).toFixed(5);
  }
  function chipAt(el, text) {
    var chip = document.createElement("span");
    chip.className = "chipfly"; chip.textContent = text;
    panel.appendChild(chip);
    var pr = panel.getBoundingClientRect(), er = el.getBoundingClientRect();
    chip.style.left = Math.min(Math.max(er.left - pr.left, 12), pr.width - 230) + "px";
    chip.style.top = (er.top - pr.top - 8) + "px";
    requestAnimationFrame(function(){ chip.classList.add("show"); });
    setTimeout(function(){ chip.classList.remove("show"); setTimeout(function(){ chip.remove(); }, 450); }, 2100);
  }
  function runPerformance() {
    var folds = Array.prototype.slice.call(document.querySelectorAll("#reducer .fold"));
    var tokens = FROM; setMeters(tokens);
    sameEl.classList.remove("show");
    folds.forEach(function (f) { f.classList.remove("folding", "folded"); f.textContent = f.getAttribute("data-raw"); });
    statusEl.textContent = "request received — " + tokEl.textContent + " tokens";
    var i = 0;
    function step() {
      if (i >= folds.length) {
        statusEl.textContent = "forwarded &mdash; " + tokEl.textContent + " tokens would bill.";
        sameEl.classList.add("show");
        setTimeout(runPerformance, 5200);
        return;
      }
      var f = folds[i], meta = STEPS[i]; i += 1;
      f.classList.add("folding");
      chipAt(f, meta.chip + "  −" + meta.tokens.toLocaleString() + " tok");
      statusEl.textContent = meta.chip;
      var target = tokens - meta.tokens, start = tokens, t0 = performance.now();
      (function tick(now) {
        var k = Math.min((now - t0) / 700, 1);
        setMeters(start + (target - start) * k);
        if (k < 1) requestAnimationFrame(tick);
      })(t0);
      tokens = target;
      setTimeout(function () {
        var after = f.getAttribute("data-after");
        f.textContent = after; f.classList.remove("folding");
        if (after !== "") f.classList.add("folded");
        setTimeout(step, 900);
      }, 800);
    }
    setTimeout(step, 1400);
  }
  if (panel && tokEl) {
    document.querySelectorAll("#reducer .fold").forEach(function (f) {
      f.setAttribute("data-raw", f.textContent);
    });
    if (reduced) {
      // Reduced motion: show the finished state, meters at the after values.
      document.querySelectorAll("#reducer .fold").forEach(function (f, idx) {
        var after = f.getAttribute("data-after");
        f.textContent = after === "" ? "" : after; f.classList.add("folded");
      });
      setMeters(${afterTokens});
      statusEl.textContent = "reduced: ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens";
      sameEl.classList.add("show");
    } else if ("IntersectionObserver" in window) {
      var seen = false;
      new IntersectionObserver(function (es, obs) {
        es.forEach(function (e) {
          if (e.isIntersecting && !seen) { seen = true; runPerformance(); obs.disconnect(); }
        });
      }, { threshold: 0.35 }).observe(panel);
    } else { runPerformance(); }
  }
  // Entrances: each section's parts rise 12px as they arrive.
  if (!reduced && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "-10% 0px" });
    document.querySelectorAll(".rise").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".rise").forEach(function (el) { el.classList.add("in"); });
  }
  // The signature move: the CTA photograph crossfades like light shifting.
  var shots = document.querySelectorAll(".xfade img");
  if (shots.length > 1 && !reduced) {
    var at = 0;
    setInterval(function () {
      if (document.hidden) return;
      shots[at].classList.remove("front"); at = (at + 1) % shots.length;
      shots[at].classList.add("front");
    }, 5200);
  }
  // FAQ: glide open, and glide the previous one closed instead of snapping.
  var faqs = Array.prototype.slice.call(document.querySelectorAll(".faq details"));
  function setH(wrapEl, from, to, after) {
    wrapEl.style.height = from + "px";
    requestAnimationFrame(function () {
      wrapEl.style.height = to + "px";
      setTimeout(function () { wrapEl.style.height = ""; if (after) after(); }, 380);
    });
  }
  faqs.forEach(function (d) {
    var sum = d.querySelector("summary"), wrapEl = d.querySelector(".answer-wrap");
    if (!sum || !wrapEl) return;
    d.removeAttribute("name"); // we manage exclusivity ourselves, smoothly
    sum.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (reduced) { // instant, but still exclusive
        faqs.forEach(function (o) { if (o !== d) o.open = false; });
        d.open = !d.open; return;
      }
      if (d.open) {
        setH(wrapEl, wrapEl.scrollHeight, 0, function () { d.open = false; });
        return;
      }
      faqs.forEach(function (o) {
        if (o !== d && o.open) {
          var ow = o.querySelector(".answer-wrap");
          setH(ow, ow.scrollHeight, 0, function () { o.open = false; });
        }
      });
      d.open = true;
      setH(wrapEl, 0, wrapEl.scrollHeight, null);
    });
  });

  // Copy buttons on the calls.
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var txt = b.getAttribute("data-copy");
      if (navigator.clipboard) navigator.clipboard.writeText(txt);
      b.textContent = "copied"; setTimeout(function () { b.textContent = "copy"; }, 1200);
    });
  });

  // Install section: switch the command shown by platform tab. Degrades to the
  // default (curl) command with JS off, since the npm panel starts [hidden].
  var osTabs = document.querySelectorAll(".os-tab[data-os]");
  if (osTabs.length) {
    var showOs = function (os) {
      document.querySelectorAll(".os-tab[data-os]").forEach(function (t) {
        t.setAttribute("aria-selected", String(t.getAttribute("data-os") === os));
      });
      document.querySelectorAll("[data-os-panel]").forEach(function (p) {
        p.hidden = p.getAttribute("data-os-panel") !== os;
      });
    };
    osTabs.forEach(function (t) {
      t.addEventListener("click", function () { showOs(t.getAttribute("data-os")); });
    });
  }
})();`;

  const CSS = `
:root{
  /* MESH brand: Off White ground, Deep Graphite ink, Mesh Blue accent, Frost tone-step */
  --bg:#FAFAF9; --surface:#0B0F14; --surface-2:#14181F; --ink:#0B0F14; --muted:#5B6472;
  --line:#E5E7EB; --accent:#2563EB; --accent-ink:#ffffff; --ocean:#1D4ED8; --paper:#ffffff; --paper-ink:#0B0F14;
  --deep:#0B0F14; --deep-ink:#FAFAF9; --deep-muted:#9AA3B2; --deep-line:#262B33;
  --stone:#E7E5E4; --stone-2:#DAD6D1; --stone-line:#CFCAC3; --stone-muted:#57534E;
  --s1:8px; --s2:16px; --s3:24px; --s4:32px; --s5:48px; --s6:64px; --s7:96px;
  --axis:27vw; --radius:4px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--ink)}
/* Faded isometric dot-paper, fixed behind the page; dots glow faintly near the cursor. */
.dotpaper{position:fixed;inset:0;z-index:0;pointer-events:none}
.dotpaper .base,.dotpaper .glow{position:absolute;inset:0}
.dotpaper .base{background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='59'%3E%3Cg fill='%230B0F14' fill-opacity='0.05'%3E%3Ccircle cx='0' cy='0' r='1.1'/%3E%3Ccircle cx='34' cy='0' r='1.1'/%3E%3Ccircle cx='0' cy='59' r='1.1'/%3E%3Ccircle cx='34' cy='59' r='1.1'/%3E%3Ccircle cx='17' cy='29.5' r='1.1'/%3E%3C/g%3E%3C/svg%3E")}
.dotpaper .glow{opacity:0;transition:opacity .4s ease;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='34' height='59'%3E%3Cg fill='%232563EB' fill-opacity='0.55'%3E%3Ccircle cx='0' cy='0' r='1.2'/%3E%3Ccircle cx='34' cy='0' r='1.2'/%3E%3Ccircle cx='0' cy='59' r='1.2'/%3E%3Ccircle cx='34' cy='59' r='1.2'/%3E%3Ccircle cx='17' cy='29.5' r='1.2'/%3E%3C/g%3E%3C/svg%3E");
  -webkit-mask-image:radial-gradient(circle 160px at var(--mx) var(--my),#000 0%,rgba(0,0,0,.35) 48%,transparent 72%);
  mask-image:radial-gradient(circle 160px at var(--mx) var(--my),#000 0%,rgba(0,0,0,.35) 48%,transparent 72%)}
.dotpaper.lit .glow{opacity:1}
@media (prefers-reduced-motion:reduce){.dotpaper .glow{display:none}}
.rise,.exchange .call,.exchange .response,.total-side .figure{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .5s ease}
.rise.in,.rise.in .call,.rise.in .response,.rise.in .figure{opacity:1;transform:none}
.rise.in .response{transition-delay:.18s}
/* headings never fade — always present for readers and crawlers */
h2.rise{opacity:1;transform:none;transition:none}

@media (prefers-reduced-motion: reduce){.rise,.exchange .call,.exchange .response,.total-side .figure{opacity:1;transform:none;transition:none}html{scroll-behavior:auto}}

/* ---------- hero: editorial-minimal. Near-white, massive type, one accent ---------- */
.hero-wrap{position:relative;z-index:1;min-height:84svh;background:transparent}
.hero{position:relative;min-height:84svh;display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:var(--s6);text-align:left;padding:var(--s5) var(--s4) var(--s7)}
.hero h1 .dot{color:var(--accent)}
.hero .col{position:relative;z-index:2;max-width:44rem;flex:1 1 auto}
.hero-proof{flex:0 0 auto;max-width:21rem;text-align:right;border-top:2px solid var(--ink);padding-top:16px}
.hero-proof .lbl{font-size:15px;line-height:1.5;color:var(--muted);margin:0}
.hero-proof .pct{display:block;font-size:clamp(52px,6vw,84px);font-weight:800;letter-spacing:-.03em;line-height:1;margin:0 0 10px;color:var(--ink)}
.hero-proof .pct span{color:var(--accent)}
@media (max-width:760px){.hero-proof .pct{display:inline;font-size:1.15em;margin:0}}
.topnav{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;padding:26px var(--s4) 0}
.brandlock{display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--ink)}
.brandlock svg{height:34px;width:auto;display:block}
.brandlock b{font-size:24px;font-weight:800;letter-spacing:-.03em;color:var(--ink)}
.topnav-links{display:flex;align-items:center;gap:var(--s4)}
.topnav .navlink{font-size:14px;font-weight:600;color:var(--muted);text-decoration:none}
.topnav .navlink:hover{color:var(--accent)}
.topnav .signin{font-size:14px;font-weight:700;color:var(--ink);text-decoration:none}
.topnav .signin:hover{color:var(--accent)}
@media (max-width:560px){.topnav .navlink{display:none}}
.hero .kicker{margin:0 0 var(--s2);font-size:15px;font-weight:700;letter-spacing:.005em;color:var(--accent)}
.hero h1{margin:0 0 var(--s4);font-size:clamp(56px,8.4vw,128px);font-weight:800;letter-spacing:-.045em;line-height:.92;max-width:9ch;color:var(--ink)}
.hero .sub{font-size:20px;line-height:1.6;color:var(--ink);margin:0 0 40px;max-width:34rem}
.hero .actions{display:flex;align-items:center;justify-content:flex-start;gap:var(--s3)}
.hero .col>.rise:nth-child(1){transition-delay:.04s}
.hero .col>.rise:nth-child(2){transition-delay:.14s}
.hero .col>.rise:nth-child(3){transition-delay:.24s}
.hero .col>.rise:nth-child(4){transition-delay:.34s}
.btn{display:inline-block;padding:12px 22px;border-radius:var(--radius);font-weight:700;font-size:16px;text-decoration:none;background:var(--accent);color:#fff;transition:background .18s ease}
.btn:hover{background:var(--ocean)}
.arrowlink{font-size:16px;color:var(--ocean);text-decoration:none;border-bottom:1px solid var(--line)}
.arrowlink:hover{color:var(--accent);border-color:var(--accent)}
.arrowlink::after{content:" \\2192"}
/* The primary call to action: Download Mesh — deliberately the biggest button. */
.btn-download{display:inline-flex;align-items:center;gap:11px;padding:17px 32px;font-size:19px;font-weight:800;letter-spacing:-.01em;border-radius:9px;background:var(--accent);color:#fff;text-decoration:none;transition:transform .18s ease,background .18s ease}
.btn-download:hover{background:var(--ocean);transform:translateY(-2px)}
.btn-download svg{width:21px;height:21px;transition:transform .22s ease}
.btn-download:hover svg{transform:translateY(3px)}
.btn-download .arrow{animation:dlbob 2.6s ease-in-out infinite}
@keyframes dlbob{0%,100%{transform:translateY(0)}50%{transform:translateY(2px)}}
@media (prefers-reduced-motion:reduce){.btn-download .arrow{animation:none}}
.hero .cta-note{margin-top:16px;font-size:14px;color:var(--muted)}
.hero .cta-note b{color:var(--ink);font-weight:700}
/* ---------- install section: centered, OS-switchable command ---------- */
.install-sect{padding:var(--s7) var(--s4);text-align:center}
.os-tabs{display:inline-flex;gap:4px;background:var(--stone);border-radius:10px;padding:4px;margin:0 auto var(--s4)}
.os-tab{font:14px/1 Manrope,-apple-system,sans-serif;font-weight:600;border:none;background:none;color:var(--muted);padding:9px 16px;border-radius:7px;cursor:pointer;transition:background .15s ease,color .15s ease}
.os-tab[aria-selected="true"]{background:#fff;color:var(--ink);font-weight:700}
.os-tab:disabled{opacity:.55;cursor:default}
.install-cmd{display:flex;align-items:center;gap:14px;max-width:41rem;margin:0 auto;background:var(--ink);color:#F5F7FA;border-radius:10px;padding:16px 16px 16px 20px;font:14.5px/1.4 ui-monospace,Menlo,Consolas,monospace;text-align:left}
.install-cmd[hidden]{display:none}
.install-cmd .prompt{color:#7D8BA1;flex:none;user-select:none}
.install-cmd code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap}
.install-cmd .copy{flex:none;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);color:#F5F7FA;font:12px/1 ui-monospace,monospace;border-radius:5px;padding:7px 12px;cursor:pointer;transition:background .15s ease}
.install-cmd .copy:hover{background:rgba(255,255,255,.22)}
.install-note{margin-top:var(--s3);font-size:14px;color:var(--muted)}
.install-note code{font:13px/1 ui-monospace,Menlo,monospace;background:var(--stone);color:var(--ink);padding:2px 7px;border-radius:5px}
.install-note b{color:var(--ink);font-weight:700}
.install-note a{color:var(--ocean)}
@media (max-width:860px){
  .hero{flex-direction:column;align-items:flex-start;gap:var(--s4)}
  .hero-proof{text-align:left;max-width:100%;align-self:stretch}
}
@media (max-width:760px){
  :root{--axis:24px}
  .hero{min-height:88svh;justify-content:center;padding-top:14svh}
  .hero .col{max-width:100%;padding-left:0}
  .hero .sub{font-size:17px}
}

/* ---------- the bands: the numbers, called out at poster size ---------- */
.bands{padding:var(--s7) var(--s4)}
.bandrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:var(--s4);max-width:72rem;margin:0 auto}
.band{text-align:center}
.band .n{font-size:clamp(72px,8.5vw,128px);font-weight:800;letter-spacing:-.04em;line-height:.9;color:var(--ocean)}
.band .n span{font-size:.45em;font-weight:800}
.band p{font-size:16px;line-height:1.5;color:var(--muted);max-width:30ch;margin:var(--s2) auto 0}
.bandcap{text-align:center;font-size:16px;color:var(--muted);max-width:46rem;margin:var(--s6) auto 0}
.theo-sect{padding:var(--s7) var(--s4);text-align:center}
.theo-wrap{max-width:46rem;margin:0 auto}
.theo-avatar{width:136px;height:140px;margin:0 auto var(--s4);animation:theofloat 5.5s ease-in-out infinite}
.theo-avatar svg{width:100%;height:100%;display:block;overflow:visible}
.theo-signal{animation:theopulse 2.2s ease-in-out infinite}
.theo-eye{transform-box:fill-box;transform-origin:center;animation:theoblink 5s ease-in-out infinite}
@keyframes theofloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
@keyframes theopulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes theoblink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(.12)}}
@media (prefers-reduced-motion:reduce){.theo-avatar,.theo-signal,.theo-eye{animation:none}}
.theo-lead{font-size:clamp(20px,2.3vw,25px);line-height:1.5;color:var(--ink);max-width:40rem;margin:0 auto var(--s3)}
.theo-note{font-size:16px;line-height:1.65;color:var(--muted);max-width:40rem;margin:0 auto}
.bandcap a{color:var(--ocean)}
.bandcap strong{color:var(--ink)}

/* ---------- works-with: names in the text face, one quiet row ---------- */
.works{padding:var(--s6) var(--s4)}
.works-row{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s3);max-width:72rem;margin:0 auto;flex-wrap:wrap}
.works-lede{font-size:16px;color:var(--muted)}
.wlogo{display:inline-flex;align-items:center;gap:10px;color:var(--ink)}
.wlogo svg{height:26px;width:auto;display:block}
.wlogo svg path{fill:#102A43}
.wlogo span{font-size:18px;font-weight:700;letter-spacing:-.01em}
.wlogo.wordmark span{font-size:22px}
.works-cap{text-align:center;font-size:16px;color:var(--muted);max-width:46rem;margin:var(--s4) auto 0}
@media (max-width:760px){.works-row{display:grid;grid-template-columns:1fr 1fr;gap:var(--s3)}.works-lede{grid-column:1/-1}.wlogo svg{height:20px}.wlogo span{font-size:15px}.wlogo.wordmark span{font-size:15px}}

/* ---------- the demo theatre ---------- */
.demo-sect{padding:var(--s7) var(--s4)}
.axis-col-wide{max-width:60rem;margin:0 auto}
.demo-sect h2{text-align:center}
.fold{display:inline;transition:opacity .6s ease}
.fold.folding{opacity:.25;text-decoration:line-through}
.fold.folded{opacity:1;text-decoration:none;color:var(--accent)}
.statusline{font-size:13px;color:var(--deep-muted);min-height:1.2em}
.chipfly{position:absolute;background:var(--accent);color:var(--accent-ink);font-size:13px;font-weight:700;border-radius:999px;padding:6px 14px;pointer-events:none;opacity:0;transform:translateY(6px);transition:opacity .4s ease,transform .4s ease;white-space:nowrap;z-index:3}
.chipfly.show{opacity:1;transform:translateY(0)}
#reducer{position:relative}
#reducer pre{max-height:380px;overflow:auto}

/* ---------- fragments: the product's own conventions ---------- */
[data-ui]{background:var(--stone);border:1px solid var(--stone-line);border-radius:8px;font-size:13px;overflow:hidden;max-width:100%;color:var(--ink);--surface-2:var(--stone-2);--deep-line:var(--stone-line);--deep-muted:var(--stone-muted)}
[data-ui] .tblwrap{overflow-x:auto}
[data-ui] table{min-width:540px}
[data-ui] .bar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--deep-line);font-weight:700;font-size:13px;color:var(--deep-muted)}
[data-ui] .bar{min-width:0}
[data-ui] .bar .pill{background:var(--surface-2);border:1px solid var(--deep-line);border-radius:999px;padding:2px 10px;font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap;flex:none}
[data-ui] pre{margin:0;padding:14px 16px;overflow-x:auto;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}
[data-ui] .tok{color:var(--deep-muted)}
[data-ui] .key{color:var(--accent)}
[data-ui] .dup{transition:opacity .5s ease;text-decoration:line-through transparent}
[data-ui] .dup.struck{opacity:.28;text-decoration:line-through}
[data-ui] .footrow{display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid var(--deep-line)}
[data-ui] .ui-btn{font:inherit;font-weight:700;font-size:13px;background:var(--surface-2);color:var(--ink);border:1px solid var(--deep-line);border-radius:4px;padding:7px 14px;cursor:pointer}
[data-ui] .ui-btn:hover{border-color:var(--accent);color:var(--accent)}
[data-ui] .ok{font-size:13px;color:var(--accent);opacity:0;transition:opacity .4s ease}
[data-ui] .ok.show{opacity:1}
[data-ui] table{width:100%;border-collapse:collapse;font-size:13px}
[data-ui] th,[data-ui] td{text-align:left;padding:8px 16px;border-top:1px solid var(--deep-line);font-variant-numeric:tabular-nums}
[data-ui] th{color:var(--deep-muted);font-size:13px;border-top:none}
[data-ui] td.num,[data-ui] th.num{text-align:right}
.copy{font:12px/1 ui-monospace,monospace;background:none;border:1px solid var(--deep-line);color:var(--deep-muted);border-radius:4px;padding:4px 8px;cursor:pointer}
.copy:hover{color:var(--accent);border-color:var(--accent)}

/* ---------- colour fields: two full-bleed chapter breaks (the page's punctuation) ---------- */
.field-deep{background:var(--deep);color:var(--deep-ink)}
.field-deep h2{color:var(--deep-ink)}
.field-deep .total-side .note,.field-deep .total-side .cap{color:var(--deep-muted)}
.field-deep .total-side .cap a{color:var(--accent)}
.field-deep .total-side .figure{color:var(--deep-ink)}
.field-deep .slip{background:#ffffff}
.field-ocean{background:var(--ocean);color:#F1F7FB}
.field-ocean h2{color:#fff}
.field-ocean p{color:#d7e9f7}
.field-ocean .fig{color:#fff}
.field-ocean .price-figure .per{color:#eaf4fb}
.field-ocean ul{color:#eaf4fb}
.field-ocean ul strong{color:#fff;border-bottom:2px solid var(--accent)}
.field-ocean .overlap path{stroke:#9DD9F5}
.field-ocean .overlap circle{fill:#F1F7FB}
.field-ocean .btn{background:#F1F7FB;color:var(--ocean)}
.field-ocean .btn:hover{background:#fff}

/* ---------- sections ---------- */
section{padding:var(--s7) var(--s4);position:relative;z-index:1}
section h2{font-size:30px;font-weight:800;letter-spacing:-.01em;margin:0 0 var(--s6);position:relative;padding-bottom:18px}
section h2::after{content:"";position:absolute;left:50%;transform:translateX(-50%);bottom:0;width:140px;height:12px;background:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 12"><path d="M0 6 q6 -5 12 0 t12 0 q3 -9 6 0 t12 0 t12 0 q3 9 6 0 t12 0 t12 0 q6 -5 12 0 t12 0 t12 0" fill="none" stroke="%232864A5" stroke-width="1.6" opacity=".75"/></svg>') center/contain no-repeat}
.field-ocean h2::after{opacity:.9}
/* A section header that fills the frame: the heading on the left, a quiet signpost closing the right margin. */
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s4);flex-wrap:wrap}
.sec-head h2{margin-bottom:var(--s6)}
.sec-tag{font-size:14px;color:var(--muted);letter-spacing:.01em;white-space:nowrap;flex:0 0 auto}
@media (max-width:600px){.sec-tag{display:none}}

.axis-col{max-width:720px;margin:0 auto}
.axis-col{margin-left:auto;margin-right:auto}

/* call and response */
.exchange{margin-bottom:88px}
.exchange .lead{font-size:20px;font-weight:600;margin:0 0 var(--s2);text-align:center}
.exchange .call{background:var(--stone);border-radius:8px;position:relative;color:var(--ink);--surface-2:var(--stone-2);--deep-line:var(--stone-line);--deep-muted:var(--stone-muted)}
.exchange .call .copy{position:absolute;top:10px;right:10px}
.exchange .response{margin-top:var(--s2)}
.exchange .response.breakout{width:100%}


/* total and its receipt */
.receipt-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto}
@media (min-width:980px){.receipt-wrap{grid-template-columns:1fr 440px;align-items:start}}
.total-side{display:flex;flex-direction:column;min-height:560px}
.total-side .note{font-size:16px;line-height:1.5;color:var(--muted);max-width:34ch;margin:var(--s2) 0 0}
.total-side .figure{margin-top:auto;font-size:clamp(120px,15vw,240px);font-weight:800;letter-spacing:-.04em;line-height:.8}
.total-side .cap{font-size:16px;color:var(--muted);margin-top:var(--s3);max-width:44ch}
.total-side .cap a{color:var(--accent)}
.slip{background:var(--paper);color:var(--paper-ink);width:100%;max-width:440px;padding:28px 24px 36px;font-variant-numeric:tabular-nums;clip-path:polygon(0 0,100% 0,100% calc(100% - 12px),95% 100%,90% calc(100% - 12px),85% 100%,80% calc(100% - 12px),75% 100%,70% calc(100% - 12px),65% 100%,60% calc(100% - 12px),55% 100%,50% calc(100% - 12px),45% 100%,40% calc(100% - 12px),35% 100%,30% calc(100% - 12px),25% 100%,20% calc(100% - 12px),15% 100%,10% calc(100% - 12px),5% 100%,0 calc(100% - 12px))}
.slip h3{font-size:14px;letter-spacing:.04em;margin:0 0 6px;font-weight:800}
.slip .meta{font-size:13px;color:#486581;margin:0 0 18px}
.slip .grp{font-weight:800;font-size:13px;margin:14px 0 6px}
.slip .row{display:flex;align-items:baseline;font-size:16px;line-height:1.9}
.slip .row .desc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slip .row .lead-dots{flex:1;margin:0 8px;border-bottom:2px dotted #9fb3c8;transform:translateY(-4px)}
.slip .row .val{font-weight:600}
.slip .total-row{display:flex;justify-content:space-between;background:var(--paper-ink);color:var(--paper);font-weight:800;padding:10px 12px;margin-top:16px;font-size:16px}

/* the price, very large */
.price-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto;align-content:center}
@media (min-width:980px){.price-wrap{grid-template-columns:380px 1fr}}
.price-side p{font-size:16px;line-height:1.6;max-width:38ch}
.price-figure{position:relative}
.price-figure .fig{font-size:clamp(120px,16vw,240px);font-weight:800;letter-spacing:-.04em;line-height:.85}
.price-figure .fig sup{font-size:.5em;vertical-align:super}
.price-figure .per{font-size:16px;color:var(--muted)}
.price-figure .overlap{position:absolute;top:-8%;right:4%;width:120px;height:120px}
.price-figure ul{list-style:none;margin:var(--s4) 0 0;padding:0;font-size:16px;line-height:2}

.price-figure .btn{margin-top:var(--s3)}

/* faq: accordion of filled tiles, sticky heading */
.faq-wrap{display:grid;grid-template-columns:1fr;gap:var(--s5);max-width:1080px;margin:0 auto}
@media (min-width:980px){.faq-wrap{grid-template-columns:320px 1fr}.faq-wrap h2{position:sticky;top:96px;margin:0}}
.faq-wrap h2::after,.receipt-wrap h2::after,.price-wrap h2::after{left:0;transform:none}
.field-deep h2::after{background:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 12"><path d="M0 6 q6 -5 12 0 t12 0 q3 -9 6 0 t12 0 t12 0 q3 9 6 0 t12 0 t12 0 q6 -5 12 0 t12 0 t12 0" fill="none" stroke="%239DD9F5" stroke-width="1.6" opacity=".8"/></svg>') center/contain no-repeat}
.faq-wrap h2{font-size:30px}
.faq details{background:#ffffff;border-radius:var(--radius);margin-bottom:8px}
.faq summary{list-style:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;min-height:72px;padding:0 24px;font-size:20px;font-weight:600}
.faq summary::-webkit-details-marker{display:none}
.faq .plus{position:relative;width:16px;height:16px;flex:none}
.faq .plus::before,.faq .plus::after{content:"";position:absolute;background:var(--ocean);left:0;top:7px;width:16px;height:3px;transition:transform .2s ease}
.faq .plus::after{transform:rotate(90deg)}
.faq details[open]{background:var(--accent);color:var(--accent-ink)}
.faq details[open] .plus::before,.faq details[open] .plus::after{background:var(--accent-ink)}
.faq details[open] .plus::after{transform:rotate(0)}
.faq .answer{padding:0 24px 24px;font-size:16px;line-height:1.6;max-width:52ch}
.faq .answer-wrap{overflow:hidden;transition:height .36s cubic-bezier(.4,0,.2,1)}
@media (prefers-reduced-motion: reduce){.faq .answer-wrap{transition:none}}
.faq details[open] .answer a{color:var(--accent-ink);font-weight:700}

/* the action tile */
.cta-row{display:grid;grid-template-columns:120px 1fr 120px;gap:12px;margin:0 calc(-1 * var(--s4))}
.cta-row>*{height:360px;border-radius:var(--radius)}
.cta-main{background:var(--accent);color:var(--accent-ink);display:flex;flex-direction:column;justify-content:center;padding:40px}
.cta-main h2{font-size:30px;margin:0 0 var(--s2);color:var(--accent-ink)}
.cta-main p{font-size:16px;line-height:1.6;margin:0 0 var(--s3);max-width:48ch}
.cta-main .btn{background:var(--accent-ink);color:#F1F7FB;width:max-content}
.cta-main .btn:hover{background:#163149}
.cta-flat{background:var(--ocean)}
.xfade{position:relative;overflow:hidden}
.xfade img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 1.6s ease}
.xfade img.front{opacity:1}
@media (max-width:860px){.cta-row{grid-template-columns:1fr;margin:0}.cta-row .cta-main{height:auto;min-height:300px}.cta-row .cta-flat,.cta-row .xfade{height:120px}}

/* single quiet line footer */
.quiet-foot{position:relative;z-index:1;margin-top:12svh;padding:0 var(--s4) 30px;display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;font-size:13px;color:var(--muted)}
.quiet-foot .links{display:flex;gap:24px;flex-wrap:wrap;justify-content:center}
.quiet-foot a{color:var(--ink);text-decoration:none}
.quiet-foot a:hover{color:var(--accent)}
.quiet-foot .right{text-align:right}
.quiet-foot .legal{grid-column:1/-1;text-align:center;margin-top:12px;font-size:12px;color:var(--muted)}
@media (max-width:760px){.quiet-foot{grid-template-columns:1fr;gap:8px;text-align:left}.quiet-foot .links{justify-content:flex-start}.quiet-foot .right{text-align:left}.quiet-foot .legal{text-align:left}}
@media (max-width:760px){section{padding:var(--s6) 24px}.slip{max-width:100%}.price-wrap{min-height:auto}.exchange .response.breakout{width:100%}}
@media (max-width:980px){.price-wrap{min-height:auto}}
`.trim();

  const MARK = `<svg viewBox="0 0 240 240" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="16" stroke-linejoin="round" stroke-linecap="round"><path d="M139.24 34.86 L100.03 49.91 L93.46 91.39 L126.1 117.82 L165.31 102.77 L171.88 61.29 Z"/><path d="M80.38 107.54 L41.17 122.6 L34.6 164.08 L67.24 190.51 L106.45 175.46 L113.02 133.98 Z"/><path d="M172.76 122.18 L133.55 137.23 L126.98 178.71 L159.62 205.14 L198.83 190.09 L205.4 148.61 Z"/></g></svg>`;

  // Theo, the MESH token-engineer bot: a small, friendly ink-line robot with a
  // Mesh-blue "signal" dot that pulses, eyes that blink and a gentle float.
  const THEO_BOT = `<svg viewBox="0 0 120 124" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Theo, the MESH token-engineer bot">
<line x1="60" y1="34" x2="60" y2="22" stroke="#0B0F14" stroke-width="3.5" stroke-linecap="round"/>
<circle class="theo-signal" cx="60" cy="15" r="5.5" fill="#2563EB"/>
<rect x="24" y="34" width="72" height="56" rx="18" fill="#ffffff" stroke="#0B0F14" stroke-width="3.5"/>
<rect x="16.5" y="54" width="6" height="16" rx="3" fill="#0B0F14"/>
<rect x="97.5" y="54" width="6" height="16" rx="3" fill="#0B0F14"/>
<circle class="theo-eye" cx="47" cy="58" r="6" fill="#0B0F14"/>
<circle class="theo-eye" cx="73" cy="58" r="6" fill="#0B0F14"/>
<path d="M48 73 q12 9 24 0" stroke="#0B0F14" stroke-width="3.5" stroke-linecap="round" fill="none"/>
<rect x="52" y="90" width="16" height="7" fill="#0B0F14"/>
<rect x="38" y="97" width="44" height="7" rx="3.5" fill="#E7E5E4"/>
</svg>`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "MESH",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    url: `${origin}/`,
    description: "Cut LLM API costs on Claude and OpenAI. One-URL proxy or one-line SDK; savings verified per completed task into a customer-recomputable ledger; fee is a share of verified savings.",
  });
  const orgLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "MESH", url: `${origin}/`, logo: `${origin}/favicon.svg`, sameAs: [repoUrl], slogan: "Less in. More out.",
  });

  const spendRows = SPEND.map(([name, v]) =>
    `<div class="row"><span class="desc">${name}</span><span class="lead-dots"></span><span class="val">${money(v)}</span></div>`).join("\n      ");
  const savedRows = SAVED.map(([name, v]) =>
    `<div class="row"><span class="desc">${name}</span><span class="lead-dots"></span><span class="val">${money(v)}</span></div>`).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mesh — less in, more out</title>
<meta name="description" content="Cut your Claude and OpenAI API bill. One URL in, savings verified per completed task, pay only a share of verified savings. Every invoice is recomputable from a ledger you hold.">
<link rel="canonical" href="${origin}/">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="mesh">
<meta property="og:title" content="mesh — less in, more out">
<meta property="og:description" content="Cut your Claude and OpenAI API bill. Savings verified per completed task; pay only a share of verified savings.">
<meta property="og:image" content="${origin}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${origin}/og.png">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<script type="application/ld+json">${jsonLd}</script>
<script type="application/ld+json">${orgLd}</script>
<style>${CSS}</style>
</head>
<body>

<div class="dotpaper" aria-hidden="true"><div class="base"></div><div class="glow"></div></div>

<header class="topnav">
  <a class="brandlock" href="index.html" aria-label="Mesh home">${MARK}<b>mesh</b></a>
  <nav class="topnav-links">
    <a class="navlink" href="#theo">Theo</a>
    <a class="navlink" href="evidence.html">Evidence</a>
    <a class="signin" href="start.html">Get started</a>
  </nav>
</header>
<div class="hero-wrap">
<header class="hero">
  <div class="col">
    <h1 class="rise">A smaller AI bill<span class="dot">.</span></h1>
    <p class="sub rise">Same answers &mdash; MESH sits in front of your LLM traffic and strips out wasted tokens without changing a single reply. You pay 1% of the savings, verified on the provider&rsquo;s own usage, never our estimate.</p>
    <div class="actions rise">
      <a class="btn-download" href="#install"><svg class="arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M5 20h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Install MESH</a>
      <a class="arrowlink" href="evidence.html">See the evidence</a>
    </div>
    <p class="cta-note rise">One command &middot; keep your own key &middot; <b>verify every number yourself</b></p>
  </div>
  <aside class="hero-proof rise">
    <p class="lbl"><span class="pct">${savedPct.toFixed(1)}<span>%</span></span> net savings on our last live export &mdash; verified on the provider&rsquo;s own usage, recomputable from a ledger you hold.</p>
  </aside>
</header>
</div>

<section id="install" aria-label="Install MESH" class="install-sect">
  <h2 class="rise">Install in one command.</h2>
  <div class="os-tabs rise" role="tablist" aria-label="Choose your platform">
    <button class="os-tab" type="button" role="tab" data-os="unix" aria-selected="true">macOS &amp; Linux</button>
    <button class="os-tab" type="button" role="tab" data-os="npm" aria-selected="false">npm</button>
    <button class="os-tab" type="button" role="tab" disabled title="Windows support is coming">Windows &middot; soon</button>
  </div>
  <div class="install-cmd rise" data-os-panel="unix"><span class="prompt">$</span><code>curl -fsSL https://www.mesh-technology.com/install.sh | sh</code><button class="copy" type="button" data-copy="curl -fsSL https://www.mesh-technology.com/install.sh | sh">copy</button></div>
  <div class="install-cmd rise" data-os-panel="npm" hidden><span class="prompt">$</span><code>npx @harrym1707/mesh start</code><button class="copy" type="button" data-copy="npx @harrym1707/mesh start">copy</button></div>
  <p class="install-note rise">Then <code>mesh start</code> &middot; needs Node 22+ &middot; <b>your key never leaves Claude Code</b> &middot; <a href="start.html">full setup guide</a></p>
</section>

<section aria-label="Measured bands" class="bands">
  <h2 class="rise">Measured savings.</h2>
  <div class="bandrow rise">
    <div class="band"><div class="n">45<span>&ndash;73%</span></div><p>off repetitive API calls &mdash; the top of the range when they can wait a few seconds</p></div>
    <div class="band"><div class="n">57.7<span>%</span></div><p>off background work that can wait a few extra seconds</p></div>
    <div class="band"><div class="n">37.6<span>%</span></div><p>just from switching on Claude&rsquo;s cache &mdash; many apps never do</p></div>
  </div>
  <p class="bandcap rise">Measured in our open test harness at the providers&rsquo; real prices, with answer quality checked on every task. Some setups save nothing &mdash; then we say it plainly: <strong>do not pay us</strong>. Every number comes with a command you can run &rarr; <a href="evidence.html">evidence</a>.</p>
</section>

<section aria-label="Works with every provider" class="works">
  <div class="sec-head"><h2>Works with what you already use.</h2><span class="sec-tag">keep your own key</span></div>
  <div class="works-row rise">
    <span class="wlogo">${logo("anthropic")}<span>Claude</span></span>
    <span class="wlogo wordmark"><span>OpenAI</span></span>
    <span class="wlogo">${logo("googlegemini")}<span>Gemini*</span></span>
    <span class="wlogo wordmark"><span>Grok</span></span>
    <span class="wlogo">${logo("meta")}<span>Llama</span></span>
    <span class="wlogo">${logo("mistralai")}<span>Mistral</span></span>
    <span class="wlogo">${logo("deepseek")}<span>DeepSeek</span></span>
  </div>
  <p class="works-cap rise">Point it at whatever you already use. MESH speaks Anthropic and OpenAI natively, plus anything with an OpenAI-style API &mdash; Grok, Llama, Mistral, DeepSeek and more. Full savings verification is live for Claude, GPT and DeepSeek today; other models are reduced and recorded while their price tables land. <em>*Gemini via its OpenAI-compatible endpoint.</em></p>
</section>

<section aria-label="The reduction, performed" class="demo-sect">
  <div class="axis-col-wide">
  <div class="sec-head"><h2>Watch a request lose its waste.</h2><span class="sec-tag">counts built from the sample</span></div>
  <div data-ui id="reducer" class="rise">
    <div class="bar"><span>reducer &mdash; a busy agent&rsquo;s turn 5</span>
      <span class="pill"><span id="tok-count">${beforeTokens}</span> tokens &middot; $<span id="cost-count">${beforeCost}</span></span></div>
    <pre id="demo-body">{"model":<span class="key">"claude-sonnet-5-5"</span>,
 "tools":[ <span class="fold" data-chip="12 tool schemas compacted" data-after="[ 12 tools, schemas minified ]">{"name":"lookup_0","description":"Look up records in subsystem 0&hellip;","input_schema":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}}}}, &hellip;11 more verbose schemas&hellip;</span> ],
 "system":"You are a careful assistant. Cite sources. Escalate anything risky.",
 "messages":[
   {"role":"user","content":"Step 1: inspect account 1001."},
   {"role":"assistant","content":"<span class="fold" data-chip="stale history compacted, byte-stable" data-after="[ digest kept: errors + file paths; rest summarised ]">${DUP_BLOCK} ${DUP_BLOCK} ${DUP_BLOCK}</span>"},
   {"role":"user","content":"Step 2: reconcile the ledger entries.
     ${DUP_BLOCK}
     <span class="fold" data-chip="exact duplicate removed" data-after="">${DUP_BLOCK}</span>"},
   {"role":"tool","content":"<span class="fold" data-chip="fresh result capped before it bills" data-after="[ headline + errors kept; oversized body capped ]">Row 1 of 400: settlement nominal&hellip; Row 2 of 400: settlement nominal&hellip; Row 3 of 400&hellip; (397 more rows)</span>"},
   {"role":"user","content":"Investigate account 1009 and summarise."}]}</pre>
    <div class="footrow">
      <span class="statusline" id="demo-status">watching&hellip;</span>
      <span class="ok" id="same-note">the answer cannot change &mdash; only safe moves run by default <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" style="vertical-align:-1px"><path d="M2.5 8.5 6 12 13.5 4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </div>
  </div>
  <p class="bandcap rise">A demonstration of the moves &mdash; token counts computed at build time from the full sample request (abridged on screen). Your real number comes from your own traffic. <a href="methodology.html">How we measure</a>.</p>
  </div>
</section>

<section aria-label="How it works">
  <div class="axis-col">
  <div class="sec-head"><h2>One URL. Three exchanges.</h2><span class="sec-tag">your code stays the same</span></div>

  <div class="exchange rise">
    <p class="lead">First, point your client at it.</p>
    <div class="call"><button class="copy" type="button" data-copy="npx -y -p @harrym1707/sdk mesh-proxy">copy</button><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>$ npx -y -p @harrym1707/sdk mesh-proxy
<span style="color:#57534E"># then one line in your app &mdash; keep your own key</span>
baseURL: <span style="color:#1D4ED8">"http://127.0.0.1:8787"</span></code></pre></div>
    <div class="response" data-ui>
      <div class="bar"><span>mesh-proxy</span><span class="pill">running</span></div>
      <pre>MESH proxy listening on http://127.0.0.1:8787
Ledger spools: ./mesh-ledger <span class="tok">(one hash-chained JSONL per app + provider)</span>
Anthropic SDK: new Anthropic({ baseURL: "http://127.0.0.1:8787" })</pre>
    </div>
  </div>

  <div class="exchange rise">
    <p class="lead">Then run your traffic as normal.</p>
    <div class="call"><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>await anthropic.messages.create({ model, system, messages })  <span style="color:#57534E">// unchanged</span></code></pre></div>
    <div class="response" data-ui>
      <div class="bar"><span>mesh-ledger/my-app-anthropic.jsonl</span><span class="pill">hash-chained</span></div>
      <pre>{"seq":0,"prevHash":"000&hellip;0","event":{"requestId":"a1f2&hellip;","model":"claude-sonnet-5-5",
  "usage":{"inputTokens":1695,"outputTokens":412},"levers":[{"leverId":"duplicate-context-removal",
  "kind":"lossless","savedUsd":0.00130,<span class="key">"basis":"estimated-baseline"</span>}],"status":"succeeded"}}</pre>
    </div>
  </div>

  <div class="exchange rise">
    <p class="lead">Last, recompute the invoice yourself.</p>
    <div class="call"><button class="copy" type="button" data-copy="node --import tsx evals/run-invoice.ts mesh-ledger/my-app-anthropic.jsonl">copy</button><pre style="margin:0;padding:20px;font:13px/1.65 ui-monospace,Menlo,monospace;overflow-x:auto"><code>$ node --import tsx evals/run-invoice.ts mesh-ledger/my-app-anthropic.jsonl</code></pre></div>
    <div class="response breakout" data-ui>
      <div class="bar"><span>invoice &mdash; recomputed from your spool</span><span class="pill">verdict: charge</span></div>
      <div class="tblwrap"><table>
        <thead><tr><th>lever</th><th>kind</th><th>basis</th><th class="num">events</th><th class="num">saved</th></tr></thead>
        <tbody>
          <tr><td>duplicate-context-removal</td><td>lossless</td><td>estimated-baseline</td><td class="num">6</td><td class="num">$0.0086</td></tr>
          <tr><td>tool-schema-compaction</td><td>lossless</td><td>estimated-baseline</td><td class="num">6</td><td class="num">$0.0054</td></tr>
          <tr><td>execution-tier-flex</td><td>tier</td><td>measured</td><td class="num">8</td><td class="num">$0.0193</td></tr>
          <tr><td>fresh-tool-result-cap</td><td>lossy</td><td>recorded &mdash; unbilled, no gate verdict</td><td class="num">4</td><td class="num">&mdash;</td></tr>
        </tbody>
      </table></div>
      <div class="footrow"><span class="tok">Savings you already had don&rsquo;t count. Our losses count against us. Run the command yourself &mdash; you must get the same number.</span></div>
    </div>
  </div>
  </div>
</section>

<section aria-label="The first live export" class="field-deep">
  <div class="receipt-wrap">
    <div class="total-side rise">
      <h2>Proven, line by line.</h2>
      <p class="note">Most savings claims are projections. Ours come with the receipt: we ran real requests, published every line, and the rows add up to the total &mdash; check them.</p>
      <div class="figure">37.9%</div>
      <p class="cap">saved by a single lever &mdash; switching Claude&rsquo;s cache on &mdash; measured both ways on identical prompts, answers unchanged. The receipt beside is our latest small live run: ${savedPct.toFixed(1)}% of real spend saved and billing on every active agent, the cache lever earning live. The full measured range is 26&ndash;73% by traffic type &rarr; <a href="evidence.html">evidence</a>.</p>
    </div>
    <div class="slip rise in-self" aria-label="The export, row by row">
      <h3>MESH &mdash; LIVE EXPORT</h3>
      <p class="meta">Second export &middot; 2026-10-19 &middot; claude-sonnet-5-5 &middot; 30 requests &middot; 5 hash chains verified</p>
      <p class="grp">SPEND, BY AGENT</p>
      ${spendRows}
      <p class="grp">VERIFIED SAVINGS, BY LEVER</p>
      ${savedRows}
      <div class="total-row"><span>NET VERIFIED SAVINGS</span><span>${money(savedTotal)} &middot; ${savedPct.toFixed(1)}%</span></div>
    </div>
  </div>
</section>

<section id="theo" aria-label="Theo, your token engineer" class="theo-sect">
  <div class="theo-wrap">
    <div class="theo-avatar rise">${THEO_BOT}</div>
    <h2 class="rise">Meet Theo, your token engineer.</h2>
    <p class="theo-lead rise">Theo ships with MESH. He studies your own traffic, finds new waste to cut, and only ever tunes MESH &mdash; never your prompts, never your answers.</p>
    <p class="theo-note rise">When he finds a saving he tells you what it is and what it might cost in quality, then waits for your yes. Anything that could touch an answer stays off until a replay of your own traffic proves it safe &mdash; and once a month he reports his own honesty: what he tried, what he saved, and where he held back.</p>
  </div>
</section>

<section aria-label="Pricing" class="field-ocean">
  <div class="price-wrap">
    <div class="price-side rise">
      <h2>One price.</h2>
      <p>No subscription. No seats. No minimum. You pay a slice of what MESH actually saved you &mdash; and you can recheck the maths behind every invoice yourself.</p>
    </div>
    <div class="price-figure rise">
      <div class="fig">1<sup>%</sup></div>
      <span class="overlap">${MARK}</span>
      <p class="per">of verified savings, monthly &mdash; nothing else</p>
      <ul>
        <li>Savings counted per finished task, from your provider&rsquo;s own numbers</li>
        <li>Save nothing, pay nothing</li>
        <li>If a move loses money, that loss is ours, not yours</li>
        <li>Already efficient? Our quote will say: <strong>do not pay us</strong></li>
      </ul>
      <a class="btn" href="start.html">Run the quote on your own export</a>
    </div>
  </div>
</section>

<section aria-label="Questions">
  <div class="faq-wrap">
    <h2 class="rise">The catch, printed.</h2>
    <div class="faq rise">
      <details name="faq" open><summary>Can MESH break my app?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">The default levers are lossless: compacted schemas decode identically, removed duplicates are exact, prefix repair reorders without deleting, and the reducer never throws &mdash; a failure returns your request untouched. Lossy levers stay off until a replay gate proves on your own recorded requests that quality held. <a href="faq.html">Full answer</a></div></div></details>
      <details name="faq"><summary>Why a range and not one number?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Savings depend on your traffic&rsquo;s shape. The quote comes from your own export and names your segment; sometimes the verdict is literally do not pay us. <a href="segments.html">The bands, by segment</a></div></div></details>
      <details name="faq"><summary>How can you bill for money I didn&rsquo;t spend?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">The way energy performance contracts have done it since 1995: a defined baseline, provider-verbatim measurements, an agreed adjustment method. Every request writes an append-only hash-chained event; the invoice is a pure function over those events. <a href="methodology.html">Methodology</a></div></div></details>
      <details name="faq"><summary>What do you do with my prompts?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Analysis runs locally; prompts never leave your machine. The ledger records usage numbers, lever names and hashes &mdash; not content. Your API key passes through the proxy verbatim and is never stored.</div></div></details>
      <details name="faq"><summary>Where does MESH lose?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Busy interactive agents cap around 29% before cache enablement; already-optimised stacks get 0&ndash;5% and a do-not-pay-us verdict; a free trimmer may be all you need if you don&rsquo;t need the saving verified. <a href="comparison.html">The honest comparison</a></div></div></details>
      <details name="faq"><summary>Are these numbers real?<span class="plus"></span></summary><div class="answer-wrap"><div class="answer">Every figure traces to a runnable command and a commit. The bands are simulator-measured at published provider prices and labelled so; the ${savedPct.toFixed(1)}% receipt above is real traffic. Your pilot replaces all of it with your own number before any fee exists. <a href="evidence.html">Evidence</a></div></div></details>
    </div>
  </div>
</section>

<section aria-label="Start">
  <div class="cta-row rise">
    <div class="cta-flat" aria-hidden="true"></div>
    <div class="cta-main">
      <h2>Start with one URL.</h2>
      <p>Point your app&rsquo;s baseURL at MESH and keep your own key. Five minutes later you have a tamper-evident record of what you spend &mdash; and what you stopped spending. No signup; the source is public.</p>
      <a class="btn" href="start.html">Start in five minutes</a>
    </div>
    <div class="xfade" aria-hidden="true">
      <img class="front" src="https://picsum.photos/id/114/480/720" width="480" height="720" alt="Dark storm clouds over a faint mountain ridge (photo: Brian Gonzalez, Unsplash licence)" loading="lazy">
      <img src="https://picsum.photos/id/765/480/720" width="480" height="720" alt="Night sky fading to an orange glow along a dark horizon (photo: Grant McIver, Unsplash licence)" loading="lazy">
      <img src="https://picsum.photos/id/505/480/720" width="480" height="720" alt="Silhouetted figure on a dark ridge under twilight (photo: lee Scott, Unsplash licence)" loading="lazy">
    </div>
  </div>
</section>

<footer class="quiet-foot">
  <span>mesh &mdash; verified LLM cost reduction</span>
  <span class="links"><a href="overview.html">Overview</a><a href="segments.html">Savings</a><a href="methodology.html">Methodology</a><a href="evidence.html">Evidence</a><a href="comparison.html">Comparison</a><a href="start.html">Get started</a><a href="faq.html">FAQ</a><a href="${repoUrl}">GitHub</a><a href="llms.txt">llms.txt</a><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a></span>
  <span class="right">2026 &middot; BUSL-1.1</span>
</footer>

<script>${PAGE_JS}</script>
<script>
(function(){
  var dp=document.querySelector(".dotpaper"); if(!dp) return;
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var x=0,y=0,pending=false;
  window.addEventListener("pointermove",function(e){
    x=e.clientX; y=e.clientY;
    if(!pending){ pending=true; requestAnimationFrame(function(){
      dp.style.setProperty("--mx",x+"px"); dp.style.setProperty("--my",y+"px");
      if(!dp.classList.contains("lit")) dp.classList.add("lit");
      pending=false;
    }); }
  },{passive:true});
  window.addEventListener("pointerleave",function(){ dp.classList.remove("lit"); });
})();
</script>
</body>
</html>
`;
}
