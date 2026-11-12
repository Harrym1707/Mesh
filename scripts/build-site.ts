/**
 * Build the deployable MESH website from docs/site/*.md — zero dependencies.
 *
 *   node --import tsx scripts/build-site.ts
 *
 * Output: docs/site/dist/ — static HTML pages, llms.txt at the root,
 * robots.txt, sitemap.xml, and FAQ structured data (schema.org FAQPage) so
 * answer engines can cite the pages directly. Deploying is one founder
 * action: enable GitHub Pages on the folder, or drag it into any static host.
 *
 *   MESH_SITE_ORIGIN  canonical origin (e.g. https://mesh-technology.com); a placeholder
 *                     is used (and loudly warned about) when unset.
 *   MESH_REPO_URL     where ../pilot/* links resolve (the public repo).
 *
 * The generator verifies its own output and exits non-zero on anything
 * malformed, so a broken page can never ship silently.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderLanding } from "./landing-page.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(root, "docs/site");
const outDir = path.join(siteDir, "dist");

const ORIGIN = (process.env.MESH_SITE_ORIGIN ?? "https://www.mesh-technology.com").replace(/\/$/, "");
const REPO_URL = (process.env.MESH_REPO_URL ?? "https://github.com/Harrym1707/Mesh").replace(/\/$/, "");
if (ORIGIN.includes("REPLACE-WITH-YOUR-DOMAIN")) {
  console.warn("WARNING: MESH_SITE_ORIGIN is unset; canonical URLs and the sitemap use a placeholder domain.");
}

/** Page order defines the nav. */
const PAGES: Array<{ file: string; nav: string }> = [
  { file: "start.md", nav: "Get started" },
  { file: "overview.md", nav: "Overview" },
  { file: "segments.md", nav: "Savings by segment" },
  { file: "methodology.md", nav: "Methodology" },
  { file: "evidence.md", nav: "Evidence" },
  { file: "comparison.md", nav: "Honest comparison" },
  { file: "faq.md", nav: "FAQ" },
];

/** Legal pages: built and listed in the sitemap, linked from every footer, but
 * kept out of the top nav and out of llms-full.txt. They are also where the
 * company's registered name and number are stated, as UK law requires a
 * company website to do somewhere on it. */
const LEGAL_PAGES: Array<{ file: string; nav: string }> = [
  { file: "terms.md", nav: "Terms" },
  { file: "privacy.md", nav: "Privacy" },
];
/** The registered company behind the Mesh trading name. One place, checked below. */
const REGISTERED_NAME = "Flux AI Technologies Limited";
const COMPANY_NUMBER = "17543982";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown: bold, inline code, links. Input is raw; output is HTML. */
function inline(raw: string): string {
  let text = escapeHtml(raw);
  text = text.replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    let target = href;
    if (target.startsWith("../pilot/")) target = `${REPO_URL}/blob/main/docs/pilot/${target.slice("../pilot/".length)}`;
    else if (target.endsWith(".md")) target = target.replace(/\.md$/, ".html");
    return `<a href="${target}">${label}</a>`;
  });
  return text;
}

/** Block-level markdown for the subset these pages use. */
function renderBody(markdown: string): { html: string; title: string; description: string } {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let title = "";
  let description = "";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("```")) {
      // Fenced code block: verbatim, escaped, no inline processing.
      const fenceLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        fenceLines.push(lines[index]!);
        index += 1;
      }
      index += 1; // closing fence
      out.push(`<pre class="block"><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
    } else if (line.startsWith("# ")) {
      if (title === "") title = line.slice(2).trim();
      out.push(`<h1>${inline(line.slice(2).trim())}</h1>`);
      index += 1;
    } else if (line.startsWith("### ")) {
      out.push(`<h3>${inline(line.slice(4).trim())}</h3>`);
      index += 1;
    } else if (line.startsWith("## ")) {
      out.push(`<h2>${inline(line.slice(3).trim())}</h2>`);
      index += 1;
    } else if (line.startsWith("|")) {
      const rows: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("|")) {
        rows.push(lines[index]!);
        index += 1;
      }
      const cells = (row: string): string[] => row.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const header = cells(rows[0]!);
      const bodyRows = rows.slice(rows[1]?.match(/^\|[\s:-]+\|/) ? 2 : 1);
      out.push("<div class=\"table-wrap\"><table>");
      out.push(`<thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`);
      out.push("<tbody>");
      for (const row of bodyRows) {
        out.push(`<tr>${cells(row).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      }
      out.push("</tbody></table></div>");
    } else if (line.startsWith("- ")) {
      out.push("<ul>");
      while (index < lines.length && (lines[index]!.startsWith("- ") || lines[index]!.startsWith("  "))) {
        if (lines[index]!.startsWith("- ")) {
          let item = lines[index]!.slice(2);
          index += 1;
          while (index < lines.length && lines[index]!.startsWith("  ") && !lines[index]!.startsWith("- ")) {
            item += ` ${lines[index]!.trim()}`;
            index += 1;
          }
          out.push(`<li>${inline(item)}</li>`);
        } else {
          index += 1;
        }
      }
      out.push("</ul>");
    } else if (line.trim() === "") {
      index += 1;
    } else {
      let paragraph = line;
      index += 1;
      while (index < lines.length && lines[index]!.trim() !== "" && !/^(#|\||- )/.test(lines[index]!)) {
        paragraph += ` ${lines[index]!}`;
        index += 1;
      }
      if (description === "" && title !== "") description = paragraph.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      out.push(`<p>${inline(paragraph)}</p>`);
    }
  }
  return { html: out.join("\n"), title, description: description.slice(0, 300) };
}

const CSS = `
:root{
  /* MESH brand: Off White ground, Deep Graphite ink, Mesh Blue accent, Frost tone-step */
  --bg:#FAFAF9;
  --surface:#ffffff;
  --fg:#0B0F14;
  --muted:#5B6472;
  --line:#E5E7EB;
  --brand:#2563EB;
  --signal:#2563EB;
  --signal-soft:#EEF2FE;
  --code:#F1F3F5;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#0B0F14;
  --surface:#14181F;
  --fg:#FAFAF9;
  --muted:#9AA3B2;
  --line:#262B33;
  --brand:#6B93FF;
  --signal:#6B93FF;
  --signal-soft:#17202E;
  --code:#161B22;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 Manrope,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
nav{background:var(--surface);border-bottom:1px solid var(--line);padding:.8rem 1.25rem;display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline;font-size:.92rem}
nav a{color:var(--muted);text-decoration:none;font-weight:600}
nav a.active,nav a:hover{color:var(--brand)}
nav .brand{font-weight:800;font-size:1.25rem;color:var(--brand);letter-spacing:-.02em}
nav .tagline{color:var(--muted);font-weight:400;margin-right:.5rem}
h1{font-size:1.8rem;line-height:1.2;margin:1.4rem 0 .6rem;font-weight:800;letter-spacing:-.02em}
h2{font-size:1.25rem;margin:2.2rem 0 .5rem;font-weight:800;letter-spacing:-.01em}
h3{font-size:1.05rem;font-weight:700}
a{color:var(--brand)}
strong{color:var(--fg)}
code{background:var(--code);padding:.1em .35em;border-radius:5px;font-size:.88em}
pre.block{background:#E7E5E4;color:#0B0F14;border-radius:10px;padding:1rem 1.1rem;overflow-x:auto;font-size:.85rem;line-height:1.6}
pre.block code{background:none;padding:0;font-size:inherit;color:inherit}
@media (prefers-color-scheme: dark){pre.block{background:#14181F;color:#FAFAF9;border:1px solid var(--line)}}
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px;margin:1rem 0}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{border-bottom:1px solid var(--line);padding:.6rem .75rem;text-align:left;vertical-align:top}
tr:last-child td{border-bottom:none}
th{background:var(--signal-soft);font-weight:700}
ul{padding-left:1.2rem}
li{margin:.3rem 0}
footer{border-top:2px solid var(--signal);margin-top:3rem;padding-top:1rem;font-size:.85rem;color:var(--muted)}
`.trim();

function layout(page: { file: string; nav: string }, body: string, title: string, description: string, extraHead = ""): string {
  const htmlName = page.file.replace(/\.md$/, ".html");
  const nav = ['<a href="index.html">Home</a>'].concat(PAGES.map((p) => {
    const href = p.file.replace(/\.md$/, ".html");
    const cls = p.file === page.file ? " class=\"active\"" : "";
    return `<a href="${href}"${cls}>${p.nav}</a>`;
  })).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}/${htmlName === "index.html" ? "" : htmlName}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="mesh">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${ORIGIN}/${htmlName}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ORIGIN}/og.png">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style>
${extraHead}</head>
<body>
<nav><a class="brand" href="index.html">mesh</a><span class="tagline">Less in. More out.</span>${nav}</nav>
<main>
${body}
<footer><strong>mesh</strong> — spend tokens where they matter. Every number on this site traces to a
command and a commit — <a href="evidence.html">evidence</a>. Savings are measured per completed task;
estimates are always labelled. <a href="${REPO_URL}">Source</a> · <a href="llms.txt">llms.txt</a> ·
<a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a></footer>
</main>
</body>
</html>
`;
}

/** schema.org FAQPage from faq.md's **Question?** / answer structure. */
function faqJsonLd(markdown: string): string {
  const pairs: Array<{ q: string; a: string }> = [];
  const blocks = markdown.split(/\n\n+/);
  for (let i = 0; i < blocks.length; i += 1) {
    const match = blocks[i]!.match(/^\*\*(.+?)\*\*\n([\s\S]+)$/);
    if (match) pairs.push({ q: match[1]!, a: match[2]!.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "").trim() });
  }
  if (pairs.length === 0) return "";
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: pairs.map((p) => ({
      "@type": "Question",
      name: p.q,
      acceptedAnswer: { "@type": "Answer", text: p.a },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>\n`;
}

/** schema.org HowTo for the start page: the onboarding, machine-readable. */
function startJsonLd(): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "Cut your LLM API bill with MESH in five minutes",
    description: "Run the MESH proxy with one npx command, point your app's baseURL at it, and recompute the verified-savings invoice yourself from the hash-chained ledger you hold.",
    totalTime: "PT5M",
    tool: [{ "@type": "HowToTool", name: "@harrym1707/sdk (npm)" }],
    step: [
      { "@type": "HowToStep", name: "Run the proxy", text: "npx -y -p @harrym1707/sdk mesh-proxy — starts a local proxy on http://127.0.0.1:8787 with a hash-chained ledger in ./mesh-ledger. No signup; your API key passes through and is never stored." },
      { "@type": "HowToStep", name: "Point your app at it", text: "Change one line: new Anthropic({ baseURL: \"http://127.0.0.1:8787\" }) or new OpenAI({ baseURL: \"http://127.0.0.1:8787/v1\" }). Any language and any OpenAI-compatible endpoint work." },
      { "@type": "HowToStep", name: "Run traffic as normal", text: "Responses return byte-identical, streaming included. Reduction is lossless-only by default; each request appends one hash-chained event recording usage numbers and lever names, never prompt content." },
      { "@type": "HowToStep", name: "Recompute the invoice yourself", text: "Use verifyLedgerChain and recomputeInvoice from @harrym1707/sdk on your own ledger file. If MESH saved nothing the verdict reads do_not_charge. The fee is 1% of verified savings, monthly, nothing else." },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>\n`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const built: string[] = [];
writeFileSync(path.join(outDir, "index.html"), renderLanding(ORIGIN, REPO_URL), "utf8");
built.push("index.html");
for (const page of [...PAGES, ...LEGAL_PAGES]) {
  const markdown = readFileSync(path.join(siteDir, page.file), "utf8");
  const { html, title, description } = renderBody(markdown);
  const extraHead = page.file === "faq.md" ? faqJsonLd(markdown) : page.file === "start.md" ? startJsonLd() : "";
  const htmlName = page.file.replace(/\.md$/, ".html");
  writeFileSync(path.join(outDir, htmlName), layout(page, html, title, description, extraHead), "utf8");
  built.push(htmlName);
}

writeFileSync(path.join(outDir, "llms.txt"), readFileSync(path.join(siteDir, "llms.txt"), "utf8"), "utf8");
writeFileSync(path.join(outDir, "og.png"), readFileSync(path.join(siteDir, "og.png")));
// The brand mark as favicon: the three-hexagon cluster in white on a Mesh
// Blue ground. Drawn bold (silhouette only) so it survives at 16px.
writeFileSync(path.join(outDir, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#2563EB"/>
<g fill="none" stroke="#ffffff" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round">
<path d="M37.4 8.02 L26.19 12.32 L24.32 24.17 L33.64 31.72 L44.85 27.42 L46.72 15.57 Z"/>
<path d="M21.05 28.21 L9.84 32.51 L7.97 44.36 L17.29 51.92 L28.5 47.62 L30.37 35.76 Z"/>
<path d="M46.71 32.28 L35.5 36.58 L33.63 48.43 L42.95 55.98 L54.16 51.68 L56.03 39.83 Z"/>
</g>
</svg>
`, "utf8");
// GitHub Pages reads the custom domain from a CNAME file in the deploy root.
if (!ORIGIN.includes("REPLACE-WITH-YOUR-DOMAIN")) {
  writeFileSync(path.join(outDir, "CNAME"), `${new URL(ORIGIN).host}\n`, "utf8");
}
writeFileSync(path.join(outDir, "robots.txt"),
  "# Answer-engine crawlers are explicitly welcome: every number on this site\n" +
  "# traces to a runnable command, which is exactly what they should cite.\n" +
  ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "anthropic-ai",
   "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "cohere-ai"]
    .map((bot) => `User-agent: ${bot}\nAllow: /\n`).join("\n") +
  `\nUser-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, "utf8");

// llms-full.txt: the whole site's substance in one file, the way answer
// engines prefer to ingest it. Markdown sources concatenated verbatim.
writeFileSync(path.join(outDir, "llms-full.txt"),
  readFileSync(path.join(siteDir, "llms.txt"), "utf8") + "\n\n---\n\n" +
  PAGES.map((page) => readFileSync(path.join(siteDir, page.file), "utf8")).join("\n\n---\n\n"),
  "utf8");
const today = new Date().toISOString().slice(0, 10);
writeFileSync(path.join(outDir, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  built.map((name) => `  <url><loc>${ORIGIN}/${name === "index.html" ? "" : name}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
  "\n</urlset>\n", "utf8");

// --- Self-verification: a malformed page must never ship silently. ---------
const failures: string[] = [];
for (const name of built) {
  const html = readFileSync(path.join(outDir, name), "utf8");
  if (!html.includes("<title>") || html.includes("<title></title>")) failures.push(`${name}: missing title`);
  if (name === "index.html") continue; // the landing page is verified separately below
  if (/\]\(/.test(html)) failures.push(`${name}: unrendered markdown link`);
  if (/\*\*[^*]+\*\*/.test(html)) failures.push(`${name}: unrendered bold`);
  if (!html.includes("</table>") && (name === "overview.html" || name === "evidence.html")) failures.push(`${name}: expected a table`);
}
// Legal: every page links the terms and the privacy policy; those two pages state
// the registered company name and number; and the name a bulk product rename
// once produced ("Mesh AI Technologies Limited", a company that does not exist)
// can never ship again.
for (const name of built) {
  const html = readFileSync(path.join(outDir, name), "utf8");
  if (!html.includes('href="terms.html"') || !html.includes('href="privacy.html"')) failures.push(`${name}: footer links to terms/privacy missing`);
  if (/Mesh AI Technologies/i.test(html)) failures.push(`${name}: names a company that does not exist`);
}
for (const legal of LEGAL_PAGES) {
  const name = legal.file.replace(/\.md$/, ".html");
  const html = readFileSync(path.join(outDir, name), "utf8");
  if (!html.includes(REGISTERED_NAME) || !html.includes(COMPANY_NUMBER) || !html.includes("England and Wales")) {
    failures.push(`${name}: registered company name, number or place of registration missing`);
  }
}
const landing = readFileSync(path.join(outDir, "index.html"), "utf8");
for (const [marker, why] of [
  ['class="field-deep"', "dark chapter break missing"],
  ["prefers-reduced-motion", "reduced-motion guard missing"],
  ["A smaller AI bill", "hero promise missing"],
  ['id="install"', "install section missing"],
  ["install.sh | sh", "install command missing"],
  ["npx -y -p @harrym1707/sdk mesh-proxy", "the install command missing"],
  ["do not pay us", "the do-not-pay-us admission missing"],
  ["evidence.html", "evidence link missing"],
  ["SoftwareApplication", "structured data missing"],
  ["LIVE EXPORT", "the receipt is missing"],
  ["NET VERIFIED SAVINGS", "the receipt total row is missing"],
  ["37.9%", "the clean cache figure missing"],
  ['id="reducer"', "the reduction performance missing"],
  ['data-chip', "the performance folds missing"],
] as const) {
  if (!landing.includes(marker)) failures.push(`index.html: ${why}`);
}
if ((landing.match(/data-ui/g) ?? []).length < 4) failures.push("index.html: fewer than 4 product fragments");
// The receipt's rows must truly sum to its printed total (the sheet's rule,
// and ours): recompute from the printed figures.
const slipValues = [...landing.matchAll(/class="val">(−?)\$([0-9.]+)</g)]
  .map((m) => (m[1] === "−" ? -1 : 1) * Number(m[2]));
const printedTotal = landing.match(/NET VERIFIED SAVINGS<\/span><span>(−?)\$([0-9.]+)/);
if (slipValues.length < 8 || printedTotal === null) {
  failures.push("index.html: receipt rows or total missing");
} else {
  const spend = slipValues.slice(0, 5).reduce((a, b) => a + b, 0);
  const saved = slipValues.slice(5).reduce((a, b) => a + b, 0);
  const total = (printedTotal[1] === "−" ? -1 : 1) * Number(printedTotal[2]);
  if (Math.abs(saved - total) > 0.00005) failures.push(`index.html: receipt does not sum (rows ${saved} vs total ${total})`);
  if (spend <= 0) failures.push("index.html: receipt spend rows missing");
}
if (!landing.includes('rel="icon"')) failures.push("index.html: favicon link missing");
if (!readFileSync(path.join(outDir, "favicon.svg"), "utf8").includes("#2563EB")) failures.push("favicon.svg: missing the Mesh Blue brand ground");
const robots = readFileSync(path.join(outDir, "robots.txt"), "utf8");
for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
  if (!robots.includes(bot)) failures.push(`robots.txt: missing explicit allow for ${bot}`);
}
const llmsFull = readFileSync(path.join(outDir, "llms-full.txt"), "utf8");
if (llmsFull.length < 5000 || !llmsFull.includes("37.9%")) failures.push("llms-full.txt: missing or missing the numbers");
if (!landing.includes('property="og:title"')) failures.push("index.html: missing OpenGraph metadata");
const startHtml = readFileSync(path.join(outDir, "start.html"), "utf8");
if (!startHtml.includes("npx -y -p @harrym1707/sdk mesh-proxy")) failures.push("start.html: install command missing");
if (!startHtml.includes('"@type":"HowTo"')) failures.push("start.html: HowTo structured data missing");
if (!startHtml.includes("do_not_charge")) failures.push("start.html: the honest verdict missing");
const faqHtml = readFileSync(path.join(outDir, "faq.html"), "utf8");
if (!faqHtml.includes("application/ld+json") || !faqHtml.includes("FAQPage")) failures.push("faq.html: missing FAQ structured data");
if (failures.length > 0) {
  for (const failure of failures) console.error(`SITE BUILD FAILED: ${failure}`);
  process.exit(1);
}
// Host the downloadable CLI at /mesh when it has been built, so the install
// one-liner `curl -fsSL https://www.mesh-technology.com/mesh` resolves. Optional:
// a site build without the CLI artifact just omits it (and says so).
// Host the CLI: /mesh is the tiny bootstrap users download; it fetches and
// verifies /mesh-runtime against /mesh-version.json and caches it. Build the
// artifacts first with `npm run build:cli`.
const cliPkg = path.join(root, "packages/cli/pkg");
const cliFiles = ["mesh", "mesh-runtime", "mesh-version.json"];
if (existsSync(path.join(cliPkg, "mesh"))) {
  for (const file of cliFiles) copyFileSync(path.join(cliPkg, file), path.join(outDir, file));
  console.log(`CLI hosted: /mesh (${(statSync(path.join(cliPkg, "mesh")).size / 1024).toFixed(0)}KB bootstrap), /mesh-runtime, /mesh-version.json`);
} else {
  console.log(`note: packages/cli/pkg not built — /mesh download will 404. Run: npm run build:cli`);
}
// The install one-liner's target: curl -fsSL https://.../install.sh | sh
copyFileSync(path.join(siteDir, "install.sh"), path.join(outDir, "install.sh"));

console.log(`site built: ${built.length} pages + llms.txt + robots.txt + sitemap.xml -> ${path.relative(root, outDir)}`);
console.log(`canonical origin: ${ORIGIN}${ORIGIN.includes("REPLACE") ? "  <- set MESH_SITE_ORIGIN before deploying" : ""}`);
