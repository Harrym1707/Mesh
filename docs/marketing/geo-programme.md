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

_To be filled from the research commissioned on 2026-11-12._

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
