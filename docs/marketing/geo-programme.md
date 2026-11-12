# GEO content programme

How Mesh earns citations from AI answer engines (ChatGPT search, Perplexity,
Google AI Overviews, Claude, Copilot): what gets written, by whom, how often,
and what stops a bad page going out. Branch: `geo/content-programme`.

Started 2026-11-12. Nothing on this branch is live. Content reaches the public
only when a pull request from this branch is merged into `main`, which is the
founder's decision every time.

## The team

Each role is a separate agent run, so the checker never marks its own work.
The founder is the editor.

| Role | Does | Output |
|---|---|---|
| Researcher | Gathers the sources for the piece: competitor docs, pricing pages and changelogs, our own `docs/NUMBERS.md` and eval output. Records the URL and the date read for every fact | A source sheet next to the draft |
| Writer | Drafts one piece from the source sheet using the template for its type | `docs/site/blog/YYYY-MM-DD-slug.md` |
| Checker | A fresh run that did not write the piece. Applies every rule under "Rules" and runs the site build. Rejects or fixes | A pass or a list of failures in the pull request |
| Measurer | Asks each engine the prompt set, logs what came back, reports the rates | `evals/geo-observations.jsonl` and a monthly note |
| Editor (founder) | Reads the pull request, approves or sends back | The merge |

## Cadence

No study found measures posting frequency against AI citations. The cadence
below is inferred from the freshness, churn and spam-policy evidence in
"Evidence behind the cadence", and should be revisited when the measurer has
three months of our own observations.

| What | How often | Why |
|---|---|---|
| New pages, first 8 to 12 weeks | 1 a week, 2 at most | Enough to reach about 25 to 30 substantive pages. A new domain going from 10 pages to hundreds matches the pattern Google's scaled-content policy describes |
| New pages after that | 2 to 4 a month | Keeps a real reason for the site to change without volume for its own sake |
| Comparison pages | Facts checked monthly; a real revision at least quarterly | Most pages AI engines cite were updated within a year, and citations in ChatGPT and Google AI Mode churn weekly |
| Any page | Never more than 12 months without a real update | Same evidence |
| Docs and the start page | With every release | They describe the product |
| Original data (a benchmark note) | About one a quarter | Statistics, quotations and cited sources are what the one controlled study found to lift visibility |
| Off-site (Reddit, Hacker News, YouTube, review sites) | Effort comparable to on-site | Brand mentions elsewhere correlate with AI visibility far more than backlinks do, and most cited sources are not brand-owned. The plan is `docs/launch/communities.md` |

**Out-of-cycle updates.** Revise a page straight away when: a competitor
changes pricing, is acquired, pivots or shuts down; a provider changes prices
or caching terms; a Mesh release changes a claim; a fact is found wrong; or a
tracked page stops being cited.

**Too fast** means pages that would not survive the checker: no original
numbers, no sourced facts, a template filled from a keyword list. **Too slow**
means a comparison page whose prices are a quarter out of date.

### Evidence behind the cadence

Gathered 2026-11-12 by a research run; the figures are as reported by each
source and were not independently re-checked. Almost all of it comes from SEO
vendors with something to sell.

| Finding | Source |
|---|---|
| AI-cited URLs averaged 1,064 days old against 1,432 for organic results, about 26% fresher; cited pages still average about 2.9 years old. 17M citations | Ahrefs, 2025-07-28, https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content/ |
| 75% of cited pages were updated within a year and 88% within two; only 42% were first published within a year. 7,683 pages, four non-software brands | Seer Interactive, 2026-07-24, https://www.seerinteractive.com/insights/study-content-recencys-impact-on-ai-visibility-in-2026 |
| Weekly churn of cited domains: 74% in ChatGPT, 56% in Google AI Mode, 5% in AI Overviews. 82,619 prompts | SISTRIX, 2026-05-01, https://www.sistrix.com/blog/ai-citation-drift/ |
| Scaled content abuse is defined by purpose (many pages made mainly to manipulate rankings), whoever or whatever wrote them. No numeric threshold | Google Search Central spam policies, https://developers.google.com/search/docs/essentials/spam-policies |
| A sitemap `lastmod` is used only if it is consistently and verifiably accurate | Google, https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap |
| Do not re-date a page without significant new information | Google, 2019-03-11, https://developers.google.com/search/blog/2019/03/help-google-search-know-best-date-for |
| Adding quotations, statistics and cited sources lifted visibility by roughly 41%, 31% and 28%; keyword stuffing was negative. Measured on a simulated engine in 2023–24 | Aggarwal et al., "GEO: Generative Engine Optimization", https://arxiv.org/html/2311.09735v3 |
| Brand mentions across the web correlate 0.664 with AI Overview visibility; backlinks 0.218. Correlation only | Ahrefs, 2025-05-26, https://ahrefs.com/blog/ai-overview-brand-correlation/ (read from a search summary) |
| The most-cited domains are Reddit, YouTube, LinkedIn, Wikipedia, Forbes and G2. 30M sources | Peec AI, 2026-03-31, https://peec.ai/blog/top-domains-cited-by-ai-search-analysis-based-on-30m-sources |

No reliable evidence was found for: how often GPTBot, ClaudeBot or
PerplexityBot recrawl a page; AI engines discounting high-volume content
directly; FAQ or glossary pages being cited for B2B software; Hacker News or
GitHub specifically.

## Who we compare against

Vendor pages read 2026-11-12 by the same research run. Re-read each before
writing about it; "not verified" means the page did not confirm it.

| Product | What it does about cost | Pricing as read | Note |
|---|---|---|---|
| LiteLLM | Open-source proxy: budgets, spend tracking, fallbacks | Free self-hosted; enterprise by quote | On the current comparison page |
| Helicone | Observability plus gateway caching | Free, $79, $799 a month, or custom | Reported acquired by Mintlify on 2026-03-03 and in maintenance mode. **The current comparison page does not say this: check and revise** |
| Langfuse | Cost tracking only | Free, $29, $199 or $2,499 a month | On the current comparison page, which lists only the first two prices |
| Portkey | Routing, fallbacks, caching | Open source free; $49 a month production; semantic cache enterprise-only | Not yet compared |
| OpenRouter | Aggregator at provider list price | 5.5% fee on credits; own-key free to $25K a month, then 5% | Not yet compared |
| Cloudflare AI Gateway | Caching and rate limiting | Free; 5% on unified-billing credits | Not yet compared |
| Vercel AI Gateway | Budgets; no markup | No markup, including own keys | Not yet compared |
| Kong AI Gateway | Semantic cache, routing, prompt compression | Not verified | Not yet compared |
| Not Diamond | Per-prompt model routing | $0.05 per million tokens routed | Claims 20–40% savings |
| RouteLLM | Open-source router framework | Free (Apache-2.0) | Maintenance status not verified |
| LLMLingua | Open-source lossy prompt compression | Free (MIT) | Claims up to 20x |
| The Token Company | Lossy token-deletion API | Not verified | Claims 10–50% fewer tokens |
| GPTCache | Open-source semantic cache | Free (MIT) | Maintenance status not verified |
| Provider prompt caching | Anthropic and OpenAI cache reads at 0.1x | Part of provider pricing | What a customer already gets without any tool |
| Martian, Unify | Formerly routers | — | Their home pages no longer present a router. Not verified as current products; do not compare without checking |

## What gets written

| Type | Example | Why |
|---|---|---|
| Comparison | "Mesh vs LiteLLM for Claude Code costs" | The question buyers ask an engine. One competitor per page, same grid every time, including where Mesh loses |
| Mechanism post | "Why trimming tokens can raise your bill" | Explains one measured effect with the command that reproduces it. Two drafts already exist in `docs/launch/drafts/` |
| Benchmark note | A result from `evals/`, written up with `content/benchmark-template.md` | Original data is what gets cited |
| Definition | "What is prompt caching and when does it lose money" | Answers a plain question in the first two sentences |
| Changelog | What shipped this month | A real reason for the site to change |

## Rules

A draft that breaks one of these does not go to the editor.

1. **Numbers.** Every figure about Mesh comes from `docs/NUMBERS.md`, with its
   label (LIVE or SIMULATOR) and date. A figure not in that file is not used.
2. **Competitors.** Every statement about another product has a source URL
   and the date it was read, in the page. Pricing and features are quoted as
   of that date. Nothing is asserted about a competitor that its own
   documentation or a named independent measurement does not support.
3. **Where Mesh loses.** Every comparison says where the other product is the
   better choice. The existing comparison page does this; new ones must.
4. **Dates are real.** A page's "last updated" date and its sitemap date
   change only when its content changes. No re-dating to look fresh.
5. **No volume for its own sake.** One page per real question. No pages
   generated from a template across a list of keywords.
6. **Reproducible.** A claim about a measurement names the command and the
   commit.
7. **Corrections.** A wrong statement is fixed in place with a dated note,
   not silently.
8. **Company.** Mesh is a trading name of Flux AI Technologies Limited. No
   customer is named without written permission.

## How a piece ships

1. Researcher and writer produce the draft on this branch.
2. Checker runs the rules and `node --import tsx scripts/build-site.ts`.
3. A pull request is opened against `main` with the source sheet in its
   description.
4. The editor merges or sends it back. Merging deploys the site.

## First eight weeks

One piece a week, in this order. Each goes through the full pipeline.

| Week | Piece | Type |
|---|---|---|
| 1 | Revise the existing comparison page: Helicone's status, Langfuse's price tiers, every price re-read and dated | Comparison (refresh) |
| 2 | Why trimming tokens can raise your bill (from `docs/launch/drafts/`) | Mechanism |
| 3 | Mesh vs LiteLLM for Claude Code costs | Comparison |
| 4 | What prompt caching already saves you, and when it loses money | Definition |
| 5 | Mesh vs OpenRouter and the gateways that charge a percentage of spend | Comparison |
| 6 | The cache TTL heuristic we reverted (from `docs/launch/drafts/`) | Mechanism |
| 7 | Lossy prompt compression (LLMLingua, The Token Company) against a quality gate | Comparison |
| 8 | A benchmark note from `evals/`, numbers only from `docs/NUMBERS.md` | Benchmark |

## Fix first

Found on 2026-11-12 while setting this up. Each undermines the content before
any of it is written.

| Problem | Where | Effect |
|---|---|---|
| The site build has no blog section | `scripts/build-site.ts` (`PAGES`) | Nowhere to put a post, and no visible "last updated" date on any page |
| `content/entity.json` describes an early prototype | `content/entity.json` | Says routing, context optimisation and rollback are "planned"; they shipped |
| `content/ai-cost-engineering.md` has a stale status paragraph | `content/ai-cost-engineering.md` | Same |
| The prompt set has seven generic questions and no competitor or Claude Code questions | `content/geo-prompt-set.json` | Does not measure the questions the comparison pages target |
| No way to see whether an AI engine sent a visitor | The site has no analytics | The only signal is asking the engines by hand. Adding analytics is the founder's call and changes the privacy policy |

Fixed on this branch on 2026-11-12: every page in the sitemap used to get the
build date on every build, which told crawlers the whole site had changed when
nothing had. Each page now carries the date of the last commit that changed
its source (`lastChanged` in `scripts/build-site.ts`).

## Measuring whether it works

`evals/run-geo-visibility.ts` turns logged observations into mention, citation
and link rates per engine. Once a month the measurer asks every engine every
question in `content/geo-prompt-set.json` and logs one row each. The numbers
that matter: is Mesh mentioned, is it described correctly, is a Mesh page
cited, and which competitors appear instead.

A visibility rate is a marketing measure. It is never quoted as evidence that
the product works.
