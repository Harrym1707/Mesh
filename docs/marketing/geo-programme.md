# GEO content programme

How Mesh becomes findable, and accurately described, by answer engines and by
coding agents: what gets written, in what order, who checks it, and what stops
a wrong page going out. GEO here means being discoverable and correctly
described. It never means manipulating an engine.

First written 2026-11-12 on branch `geo/content-programme` (never merged).
Revised 2026-11-24 on branch `gtm/geo-editorial` against `main` at `e20a187`
(release 0.2.5), and re-checked on 2026-11-25 against `main` at `784dd82`:
the files named under "Product facts" had not changed. Nothing in this
programme is live content. A page reaches the
public only through a pull request that Harry merges.

Companion files:

- `content/geo-prompt-set.json`: the prompt panel (45 tagged questions).
- `docs/marketing/geo/page-list.md`: every planned page, in writing order, with
  its brief.
- `docs/marketing/geo/pages/<slug>.md`: where a writer puts a draft (none
  exists yet).
- `docs/marketing/geo/checks/<slug>.md`: where a checker records its verdict.

## Who asks, and what they ask

Go-to-market is agent-to-agent (Harry, 2026-11-23), so this is the channel.

**The buyer** is a team running its own agents on the Claude or OpenAI API:
coding agents, browsing agents, support agents, retrieval (RAG) pipelines and
multi-agent systems that call the API constantly. It is not a Claude Code
user: Claude Code already caches, compacts and defers tool definitions, so
Mesh adds little there (see "Who we compare against").

**Who asks the question** is one of two things:

| Asker | How it asks | What it reads |
|---|---|---|
| A developer's coding agent, told "our API bill is too high, find out what we can do" | Short search queries (`cache_read_input_tokens is 0 anthropic why`), then it fetches the pages it found and reads them in full | Documentation, READMEs, `llms.txt`, npm and GitHub metadata, the page text itself. It can run commands, so it checks whether an install command works |
| An answer engine, asked by someone building agents on the API | A full question ("How do I verify that an LLM cost tool actually saved me money?"), which the engine turns into its own web searches | Whatever its search retrieved. A page it did not retrieve cannot be cited |

**What they ask** is in the panel, by intent: the problem (my agent's bill
grows every step), the solution type (is there a proxy that does this), a
comparison (alternatives to a named tool), verification (how do I check a
savings claim), install and operate, price, and risk.

**What an engine needs in order to describe Mesh accurately:**

- The same facts on every page and surface: what Mesh is, who it is for, the
  price, what it does on a fresh install and what it does only when a lever is
  switched on.
- Those facts in plain text in the page, in the words of the question.
- Dates it can see, and sources it can open.
- The limits stated as plainly as the strengths, so that a correct answer to
  "should I use Mesh for X" can be "no".

## The story the pages tell

Two market reviews (2026-11-23) and the sources re-opened for this revision
point the same way. What survives the evidence is getting the provider's
prompt cache to hit, and a bill the customer can verify. Shrinking tokens does
not survive it: an independent study found a 38.4% cut in tool-output tokens
came with a 6.8% rise in billed cost (Weinberger and Hozez, arXiv 2607.12161
v5, 2026-08-12, https://arxiv.org/abs/2607.12161, abstract read 2026-11-24).

So:

1. **Mesh is never sold as a compressor.** No page leads with tokens removed,
   and no page says or implies that fewer tokens means a smaller bill.
2. **No page states what Mesh saves on a real provider bill.** Mesh has no
   customers and has never run on a customer's real traffic. No measurement
   of billed cost per successful task exists for Mesh. Until one does, a page
   may describe what Mesh does and quote a labelled figure for exactly what
   that figure measured, and nothing more.
3. **The pages lead with** verifying a savings claim, prompt caching for
   agents, and what a cost tool does out of the box.
4. **Every page says what Mesh does today**, separating a fresh install from
   what needs a lever switched on.

## The description and the fee

**Canonical description.** One description is used, word for word, on every
page that describes Mesh:

> Mesh is a local proxy for LLM API traffic, for teams running their own agents on the Anthropic or OpenAI API: out of the box it makes three lossless changes to each request and records every saving in a hash-chained ledger on your own machine, so you can recompute the bill yourself.

It is the constant `MESH_DESCRIPTION` in `scripts/landing-page.ts` on branch
`gtm/claims-correction` at `c6acd5c` (read 2026-11-25). That branch is pushed
and not yet merged, so the wording can still change before it reaches `main`;
a writer and a checker read the constant on `main` if it is there, and on that
branch if it is not. On that branch the site build fails when a page that
carries the description or the fee has reworded either.

**The fee**, word for word wherever it appears:

> The fee is 1% of verified savings for the month, rounded down to the cent, and nothing else; no fee is due unless billing has been agreed in writing.

This is the constant `MESH_FEE` beside it, and matches the Terms on `main`
(`docs/site/terms.md`, "Fees", read 2026-11-24).

**The name.** "Mesh" in prose. Lowercase `mesh` only for the command. Never
"MESH", and never the product's former name.

## Product facts at 0.2.5

Read from `main` at `e20a187` on 2026-11-24. A writer re-reads the file named
before using a fact; a checker re-reads it again.

| Fact | Where it was read |
|---|---|
| Version 0.2.5; the site's runtime is build `59363e8` | `packages/cli/package.json`, `docs/site/dist/mesh-version.json` |
| One path: install, then `mesh start` (Claude Code) or `mesh proxy` (any app), then `mesh verify` | `packages/cli/src/main.ts` (`TOP_USAGE`), `docs/site/start.md` |
| Install: `curl -fsSL https://www.mesh-technology.com/install.sh \| sh`, or `npm install -g @harrym1707/mesh`; needs Node 22 or newer; macOS and Linux, Windows through WSL | `docs/site/start.md` |
| `mesh proxy` listens on `http://127.0.0.1:8787`; the app sets `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` and keeps its own key | `docs/site/start.md`, `packages/cli/src/start.ts` (`--port`, `--openai-base`, `--anthropic-base`, `--no-theo`, `--capture`) |
| Commands that exist: `start`, `proxy`, `install`, `stop`, `uninstall`, `status`, `dashboard`, `theo`, `update`, `verify`, `statement`, `doctor`, `restore`, `version`, `analyse`, `compaction` | `packages/cli/src/main.ts` |
| A fresh install applies three levers, all classed lossless: `tool-schema-compaction`, `duplicate-context-removal`, `cache-prefix-repair` | `defaultPolicy` in `packages/sdk-js/src/theo-policy.ts` |
| Off unless switched on, among others: the Anthropic cache stamp (`cache-ttl-5m`, `cache-ttl-1h`), the tool-result cap (`fresh-tool-result-cap`), JSON tool-result compaction, the flex tier, output effort | `knownLeverIds` in the same file; `docs/guide/configure.md` |
| The ledger is on the customer's disk (`~/.mesh/ledger/`); `mesh statement --period YYYY-MM` recomputes a month and writes a statement signed by that install's key; `--check <file>` and `--key` exist | `packages/cli/src/statement.ts`, `docs/site/pricing.md` |
| Licence: Business Source License 1.1; licensor Flux AI Technologies Limited, trading as Mesh | `LICENSE` |
| No MCP server, no `mesh mcp`, no `mesh setup` | `packages/cli/src/main.ts` (absent) |
| No response cache and no model routing in the proxy | `docs/site/comparison.md`; not re-read in code for this revision |
| Customers: none. Mesh has never run on a customer's real traffic | Stated by the founder's team, 2026-11-23 |

Not confirmed for this revision: the licence of the separate verifier package
(the site says MIT; `packages/verify/package.json` carries no licence field).

Work that has been asked for and has not shipped (an agent-readable server, a
setup command, a fresh install that reaches the tuned result) is not a fact.
No page mentions it, and nothing about it is promised.

## Figures

`docs/NUMBERS.md` is the only source of a Mesh figure (last reconciled
2026-10-27). The lever sets below were read on 2026-11-24 from
`docs/site/evidence.md`, which traces each figure to its command, and
compared on 2026-11-25 with the corrected site copy on `gtm/claims-correction`
at `c6acd5c`, which words each figure with the levers it needed. The writer
reads the eval's own configuration before using a figure, and the checker
confirms it. Where the corrected site words a figure, a page uses the site's
wording, so that every page agrees.

The "J stack" below is the corrected site's name for six levers:
tool-description trimming, exact-duplicate removal, cache-prefix repair, a
cap on oversized tool results, stale-history compaction and an output cap.
Four of the six are off on a fresh install.

| Figure | Label and date | Pointer | Lever status |
|---|---|---|---|
| 18.2% lower spend on a 30-request basket that Mesh wrote itself | LIVE, run 2026-10-26 | `docs/NUMBERS.md` | Not out of the box: measured with the three default levers plus two that a fresh install leaves off, the Anthropic cache stamp and a gate-approved tool-result cap |
| 37.9%, multi-turn Claude traffic, the cache lever alone against the same stack with caching off | SIMULATOR, commit `6f08b72`, reconciled 2026-10-27 | `docs/NUMBERS.md` | Not out of the box: both arms run the J stack, and the difference modelled is the 5-minute Anthropic cache stamp, which is off on a fresh install |
| 34.3%, sparse interactive traffic | SIMULATOR, commit `6f08b72`, reconciled 2026-10-27 | `docs/NUMBERS.md` | Not out of the box: modelled with the J stack plus the 1-hour Anthropic cache stamp switched on |
| 57.7% net (64.3% ceiling), traffic that can wait | SIMULATOR, commit `4e51734`, reconciled 2026-10-27 | `docs/NUMBERS.md` | Not out of the box: modelled with the J stack plus the provider's flex tier switched on |

Every other row of `docs/NUMBERS.md` (45.5% and 72.8%, 57.3%, 25.9% to
29.4%, and the per-agent figures inside the 18.2% basket) is SIMULATOR or
LIVE as that file labels it, reconciled 2026-10-27, and its lever set was not
read for this revision: it is not used until a writer has read the eval's
configuration and a checker has confirmed the lever set.

What does not exist: a percentage for a fresh install. The default levers
alone did not produce the 18.2% LIVE figure (run 2026-10-26,
`docs/NUMBERS.md`, measured with two further levers switched on). The
corrected site says the three defaults account for under half of it on that
basket; a page may say that, in those words, and may not turn it into a
percentage. No fresh-install percentage is in `docs/NUMBERS.md` and no page
states one.

A sentence that passes, as a model:

> On a 30-request basket that Mesh wrote itself, spend was 18.2% lower (LIVE,
> run 2026-10-26, `docs/NUMBERS.md`) with two levers switched on that a fresh
> install leaves off: the Anthropic cache stamp and a gate-approved
> tool-result cap.

## What carries weight, and what does not

From the GEO playbook of 2026-11-23, which is kept in the team's knowledge
base and lists its sources (studies, and Google's and Microsoft's own
guidance). Its status is unverified: a research run read the pages, and they
were not re-read for this revision. Re-open a source before quoting it
publicly.

| Carries weight | In practice |
|---|---|
| Being indexed and retrieved by ordinary search | A page nobody's search returns is never cited. Search Console, Bing Webmaster Tools and the sitemap are Harry's steps |
| A title, heading and first sentence that match the question in its own words | The page title is the question. The first one or two sentences answer it and make sense alone |
| Concrete facts that agree on every page | Price, what Mesh does, for whom, its limits. The same words each time |
| Text in the served HTML | Nothing important only in an image, a tab or a script. The site is static, so this holds |
| Real updates with visible dates | A "last updated" date that changes only when the content does |
| Mentions by third parties | Cannot be written by Mesh. Off-site posting is Harry's, under his own name |

| Does not carry weight | So |
|---|---|
| A "40 to 60 word answer" rule | Not a rule here. The only source for the number is vendor text with no method |
| FAQPage, HowTo, QAPage or Speakable markup | No page adds it and no checker asks for it |
| Formatting-only edits (shorter paragraphs, more lists) | Not a reason to change a page. A table is used when it holds a comparison or a specification |
| Statistics or quotations added to look dense | Never. A figure is on a page because the page is about it. The 2023 result that favoured this did not hold on newer models |
| Keyword stuffing | Measured as harmful, and a spam-policy violation |
| A page per phrasing of a question | One page per question |

## Rules a draft must pass

A draft that breaks one of these goes back to a writer.

1. **Figures.** Every figure about Mesh is in `docs/NUMBERS.md`. The sentence
   that carries it also carries its label (LIVE or SIMULATOR), its date, a
   pointer to `docs/NUMBERS.md`, and either "out of the box" or the named
   levers that were switched on. No percentage for a fresh install appears
   anywhere. Nothing says or implies that a fresh install will improve.
   No new figure is written: no arithmetic on existing figures, no blended
   or rounded variant.
2. **No real-bill claim.** Nothing states what Mesh saves, or would save, on a
   customer's provider bill. A LIVE figure is described as what it is: a
   basket Mesh wrote itself.
3. **Not a compressor.** The page does not sell token reduction as cost
   reduction.
4. **Competitors.** Every statement about another product is followed by that
   vendor's own URL and the date it was read. A statement that could not be
   confirmed on that vendor's own pages is marked "unconfirmed" or removed.
   Nothing says a product was acquired, discontinued or put in maintenance
   mode unless its own site said so on the day it was read.
5. **Independent findings.** A third party's measurement names who measured
   it, on what, and when, with the primary URL and the date read. A figure
   seen only in a summary or a press report is marked as such or left out.
6. **Commands.** Every command, flag, path and port on the page exists in the
   code on `main`.
7. **The answer comes first.** The title is the question. The first paragraph
   answers it in the question's own words and makes sense with the rest of
   the page removed.
8. **Where Mesh loses.** Every page has this section, and it is specific:
   which reader should use something else, and what.
9. **One description, one fee.** Mesh is described with the canonical
   description and the fee statement above, word for word. Price, audience
   and limits agree with `docs/site/pricing.md` and the Terms.
10. **Nothing invented.** No customer, quotation, review, ranking, result or
    case study that does not exist. Mesh has no customers and the page never
    suggests otherwise.
11. **No manipulation.** No hidden text, no keyword stuffing, no text
    addressed to a model telling it what to say or recommend, no markup that
    claims something the visible page does not.
12. **Only what exists.** The page describes what is on `main`. Nothing
    unreleased is mentioned or promised.
13. **One question per page.** A page that would mostly repeat an existing
    page is not written; the existing page is revised.
14. **Dates are real.** "Last updated" changes only when content changes. A
    wrong statement is corrected in place with a dated note.

## Page template

Adapted from section 3 of the playbook.

```markdown
# <The question, as a person would ask it>

<The answer, in one or two sentences that make sense alone, in the question's
own words. If Mesh is part of the answer, say what Mesh is and under what
condition. If it is not, say what is.>

Last updated: YYYY-MM-DD. Checked against: <command, file or source>.

## The short version
<Three to six lines: what to do, in order, whoever's tool it is.>

## What the evidence says
<What was measured, by whom, on what, when. Third-party findings carry their
primary URL and the date read. A Mesh figure carries, in its own sentence,
its label, date, `docs/NUMBERS.md`, and "out of the box" or the named levers.>

## What Mesh does today
<Two lists: what a fresh install does, and what happens only when a named
lever is switched on. The canonical description. The fee statement, if price
is relevant.>

## Comparison
<Only when the question compares things. One table; every cell about another
product links to that vendor's own page with the date read.>

## Where Mesh loses
<Which reader should use something else, and what.>

## How to check this yourself
<The exact commands or steps.>

## Sources
<Numbered: URL or repo path, publisher, date read.>
```

Changed from the playbook's template, and why:

- **"The short version" added.** The buyer's agent wants the steps; they
  should not depend on reading a comparison.
- **"What Mesh does today" added**, split into a fresh install and
  switched-on levers. This is the figures correction applied to prose.
- **The comparison table is optional.** The playbook's own evidence is that
  layout alone does nothing; a table belongs only where there is something to
  compare.
- **The figure line now requires the lever status and `docs/NUMBERS.md`**,
  not only the label and date.
- **The opening may say Mesh is not the answer.** Several panel questions
  have an honest answer that is something else.
- **No length rule** of any kind.

## The pipeline: one writer, one checker

Each page gets one writer session and one separate checker session. Nothing
marks itself. Neither session publishes anything, runs anything against a
provider or a search API, contacts anyone, or edits `docs/site/`,
`scripts/build-site.ts`, `docs/marketing/geo/drafts/` or this programme.

Both sessions work in their own git worktree of this repository, never the
main checkout, use `corepack pnpm`, stage named paths only, and end commit
messages with the attribution line the repository uses.

### The writer

**Is given** (and nothing else of substance):

1. The slug and the panel question ids from the page's entry in
   `docs/marketing/geo/page-list.md`, with the questions themselves from
   `content/geo-prompt-set.json`.
2. The page brief from the same entry.
3. This programme: the story, the description and fee, the figures table,
   the rules and the template.
4. Optionally, a raw draft from the nightly routine (see "Who owns what"),
   read with `git show origin/geo/nightly:docs/marketing/geo/drafts/<file>`.

**Does:**

1. Cuts branch `gtm/geo-page-<slug>` from `origin/main`.
2. Opens, on that day, every source the brief lists under "Sources to open on
   the day", and every vendor page for any other product it mentions. Reads
   the code for every command it prints. Reads the eval configuration behind
   every figure it uses.
3. Writes `docs/marketing/geo/pages/<slug>.md` from the template.
4. Commits that one file and pushes the branch.
5. Opens one pull request against `main`, titled `GEO page: <slug>`. Its
   description holds only: the slug, the panel question ids, a link to the
   brief, and the line "Draft for check. Not published. Do not merge before
   the check file says PASS." If `gh` is not signed in, the writer writes that
   title and description to the shared notes folder and gives the compare
   link; it does not try another way.

**Does not** put its reasoning, or an argument for why a claim is fine, in
the pull request. Everything a reader needs is in the page's own "Sources"
section.

### The checker

A fresh session that did not write the page.

**Is given:** the pull request's branch and the path of the draft, this
programme, the page's brief, and `docs/NUMBERS.md`. It is not given the
writer's conversation or reasoning, and it does not ask for it.

**Checks,** opening every source itself on the day of the check:

| # | Check | How |
|---|---|---|
| C1 | Every Mesh figure is in `docs/NUMBERS.md`; its sentence carries label, date, pointer and lever status; the lever status is true | Find the row; read the eval's configuration at the cited command or commit; compare |
| C2 | No fresh-install percentage; no promise about a fresh install; no real-bill claim; not sold as a compressor | Read every sentence that contains a number or the words "save", "cut", "reduce", "lower" |
| C3 | Every competitor statement matches that vendor's own page today | Open each URL. A status claim (acquired, discontinued, maintenance mode) needs the vendor's own site, read that day |
| C4 | Every independent finding matches its primary source | Open it; confirm who, what, when and the figure |
| C5 | Every command, flag, path and port exists on `main` | Find each in `packages/cli/src/` or the file the page cites; `mesh <command> --help` may be run locally. Nothing is run against a provider |
| C6 | The title is the question; the first paragraph answers it alone | Read the first paragraph with the rest covered |
| C7 | "Where Mesh loses" exists and names who should use what instead | Read it |
| C8 | The canonical description and the fee statement are word for word; "Mesh" is spelt as the programme says; price and limits agree with `docs/site/pricing.md` and `docs/site/terms.md` | Compare the strings |
| C9 | Nothing invented; no manipulation; nothing unreleased | Search the file, including comments and markup, for hidden or model-directed text; search for customer names, quotations and "planned" or "soon" |
| C10 | One question; not a repeat of an existing page; dates true | Compare with `docs/site/` and `docs/marketing/geo/pages/` |

**Records its verdict in the pull request** by committing one file to the
page's branch, `docs/marketing/geo/checks/<slug>.md`, and pushing it:

```markdown
# Check: <slug>

Checked: YYYY-MM-DD, against draft commit <sha>, `main` at <sha>.
Verdict: PASS | FAIL

| # | Result | Evidence |
|---|---|---|
| C1 | pass | 18.2%: docs/NUMBERS.md row 1; lever set read in evals/run-live-agents.ts |
| C3 | FAIL | Line 41 says X; the vendor page (URL, read YYYY-MM-DD) says Y |
| ... | | |

Could not check: <anything that would not load, with the URL and the error>
```

If `gh` is signed in, the checker also leaves one pull request comment:
"Check: PASS" or "Check: FAIL", with the path of the file.

**The checker never changes the page.** It commits only the check file. A
page that fails any check goes back to a writer session, which is given the
check file and the brief, fixes the page and pushes. A new checker session
then checks the whole page again and appends a dated section to the check
file. A source that would not load is a FAIL for the claims that rest on it,
unless the page already marks them "unconfirmed". After three failed checks
the page stops and goes to Harry through the Go-to-market chat.

**After a PASS** the Go-to-market chat tells Harry the pull request is ready.
Harry merges it or sends it back. Merging puts an approved draft on `main`
under `docs/marketing/geo/pages/`. It is still not on the site.

## From approved draft to the site

A separate, later pull request publishes an approved page:

1. It moves `docs/marketing/geo/pages/<slug>.md` to `docs/site/<slug>.md` and
   changes nothing else in the text, except the "Last updated" date if the
   page was re-checked that day.
2. The page has to be registered in the site build. `scripts/build-site.ts`
   lists the pages it builds and has no section for these pages yet. That
   file belongs to whoever is carrying the build change (the Command Center);
   an editorial session does not touch it, and says in the pull request that
   the registration is needed.
3. Harry merges. The Command Center rebuilds `docs/site/dist` in a release,
   which is what deploys. `llms.txt` and the sitemap are updated in that
   build, with the page's real last-changed date.
4. If more than seven days have passed since the check, a checker re-opens
   the competitor sources first.

## Who owns what

| | Owner | Where |
|---|---|---|
| Measurement: search visibility, the live-site audit, nightly notes | The nightly routine (branch `geo/nightly`, pull request #67, managed by the Command Center) | `docs/metrics/geo/` |
| Raw drafts, at most one a night | The nightly routine | `docs/marketing/geo/drafts/` |
| The prompt panel | Editorial (the Go-to-market chat) | `content/geo-prompt-set.json` |
| This programme, the page list, pages and checks | Editorial | `docs/marketing/geo-programme.md`, `docs/marketing/geo/` except `drafts/` |
| The site sources and the build | The site-correction session and the Command Center | `docs/site/`, `scripts/build-site.ts` |
| Merging anything | Harry | |

Editorial never edits `geo/nightly`, `docs/metrics/geo/` or `drafts/`. The
routine never edits the panel, the page list, `pages/` or `checks/`.

**How the two meet.**

- The routine reads `version` and `queries` from the panel. Those two fields
  keep their meaning: `queries` is the plain list of questions. Version 2
  lists 45 where version 1 listed 7, so a night that searches every question
  makes 45 searches. If that is too many, the routine can take the 22
  questions marked `core` in `panel`; that choice is the Command Center's.
- Three version 1 questions are kept word for word so the routine's log has
  a continuous series. The four dropped ones are under `retiredQueries`.
- A raw draft is material a writer may start from. It has no standing: the
  page is written on its own branch against its brief, and goes through the
  same checker as any other.
- A raw draft that answers a question not in the page list is not written up
  until the Go-to-market chat has added an entry and a brief for it.
- As of 2026-11-25 the routine has run twice and written no draft. Its
  latest notes propose drafting a page for "How do I reduce token usage in an
  AI SaaS product?". That question is retired in version 2 of the panel, and
  a page built on reducing token usage runs against the story above; the
  nearest entry in the page list is `token-reduction-vs-cost-reduction`.
- On its second night the routine rewrote the top of `docs/site/llms.txt` on
  its own branch. `gtm/claims-correction` rewrites the same file. That is
  between those two branches and the Command Center; editorial touches
  neither.

## Cadence

No study found measures posting frequency against AI citations. The cadence
below is inferred from freshness, churn and spam-policy evidence, not
measured, and should be revisited once three months of Mesh's own
observations exist.

| What | How often | Why |
|---|---|---|
| The first three pages | Now, one writer and one checker each | They depend on nothing unreleased |
| New pages after that, for 8 to 12 weeks | 1 a week, 2 at most | A new site going from ten pages to hundreds matches the pattern Google's scaled-content policy describes |
| New pages after that | 2 to 4 a month | A real reason for the site to change, without volume for its own sake |
| Comparison pages | Facts re-opened monthly; a real revision at least quarterly | Prices and ownership change. Several products in the table below show a new owner, or say they are no longer maintained, on their own sites today |
| Any page | Never more than 12 months without a real update | Freshness evidence |
| The start and pricing pages | With every release | They describe the product |
| An original, dated measurement | When one exists, not on a schedule | Original data is what a page has that a listicle does not. Nothing is added to look dense |
| Off-site | Harry's, under his own name | Third-party mentions carry weight, and Mesh cannot write them |

**Out-of-cycle revisions.** Straight away when: a competitor changes price,
owner or status; a provider changes prices or caching terms; a Mesh release
changes a claim; a fact is found wrong.

**The weekly rhythm, once the first three pages are approved:**

1. The Go-to-market chat takes the next entry in `page-list.md` that is not
   held, re-reads its "Held until" line, and starts a writer session.
2. When the writer's pull request exists, it starts a checker session.
3. On PASS, Harry is told. On FAIL, a writer session gets the check file.
4. In the first week of each month, a checker session re-opens the sources of
   every published comparison page. A changed fact starts a writer revision.
5. The page list is updated in the same week: status, date, and the raw draft
   used, if any.

Evidence behind the cadence, gathered 2026-11-12 by a research run. The
figures are as each source reported them, were not re-checked then or for
this revision, and almost all come from SEO vendors.

| Finding | Source |
|---|---|
| AI-cited URLs averaged about 26% fresher than organic results; cited pages still average about 2.9 years old. 17M citations | Ahrefs, 2025-07-28, https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content/ |
| 75% of cited pages were updated within a year; only 42% were first published within a year. 7,683 pages, four non-software brands | Seer Interactive, 2026-07-24, https://www.seerinteractive.com/insights/study-content-recencys-impact-on-ai-visibility-in-2026 |
| Weekly churn of cited domains: 74% in ChatGPT, 56% in Google AI Mode, 5% in AI Overviews. 82,619 prompts | SISTRIX, 2026-05-01, https://www.sistrix.com/blog/ai-citation-drift/ |
| Scaled content abuse is defined by purpose, whoever or whatever wrote the pages. No numeric threshold | Google Search Central, https://developers.google.com/search/docs/essentials/spam-policies |
| A sitemap `lastmod` is used only if it is consistently and verifiably accurate | Google, https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap |

Removed from the 2026-11-12 table: the 2023 finding that adding quotations
and statistics lifts visibility. The playbook reports that it did not hold on
newer models, so it no longer supports anything here.

## Who we compare against

Each row was read on 2026-11-24 at the URL given, through a fetch tool that
returns page text. Where a GitHub repository is named, its status came from
GitHub's public API the same day. This table is for planning. A page that
uses a row re-opens the source on the day it is written, and again on the day
it is checked.

| Product | What its own pages said on 2026-11-24 | Source | Unconfirmed |
|---|---|---|---|
| LiteLLM | The gateway is MIT-licensed and free to self-host; enterprise is "Request pricing". Anthropic cache breakpoints can be injected automatically (`cache_control_injection_points` per model, or `enable_anthropic_prompt_caching` since v1.94.0), off by default. Response caching, exact and semantic, exists and is configured. MCP tool search is opt-in per key | https://www.litellm.ai/ ; https://docs.litellm.ai/docs/tutorials/prompt_caching ; https://docs.litellm.ai/docs/proxy/caching ; https://docs.litellm.ai/docs/mcp_tool_search | The prompt-caching page describes no check that a cached prefix is stable and no warning on zero cache reads; absence on one page is not proof. Mesh's own test of v1.106.4, quoted on the live comparison page, has not been re-run on a current version |
| Helicone | The home page carries the banner "Helicone is now part of Experiential Labs. Details to come soon." Plans: Hobby free, Pro $79 a month, Team $799 a month, Enterprise on request, with usage-based pricing on top. A response cache is enabled by a request header, default lifetime 7 days. The repository is Apache-2.0, not archived, last pushed 2026-11-17 | https://www.helicone.ai/ ; https://www.helicone.ai/pricing ; https://docs.helicone.ai/features/advanced-usage/caching ; https://github.com/Helicone/helicone | **Maintenance mode, and acquisition by Mintlify: unconfirmed.** Mintlify's post of 2026-03-03 says it is acquiring Helicone and that Helicone continues in maintenance mode (https://www.mintlify.com/blog/mintlify-acquires-helicone, read 2026-11-24). Helicone's own home page, pricing page, blog index and docs home say neither, and the home page names a different company. Two Helicone URLs said to carry the announcement return 404. Do not state either |
| Portkey | The home page says "Portkey is now PRISMA AIRS AI Gateway" and names Palo Alto Networks. Simple (exact) caching is on all plans; semantic caching only on select Enterprise plans. The open-source gateway repository is MIT, not archived, last pushed 2026-11-20 | https://portkey.ai/ ; https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic ; https://github.com/Portkey-AI/gateway ; Palo Alto Networks' release of 2026-05-29 says it closed the acquisition: https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents | Prices: `portkey.ai/pricing` redirects to a Palo Alto Networks contact page, which was not read. Terms for self-hosting |
| Langfuse | Plans: Hobby free, Core $29 a month, Pro $199 a month, Enterprise $2,499 a month; self-hosting is free. Cost tracking uses usage submitted by the integration | https://langfuse.com/pricing ; https://langfuse.com/docs/observability/features/token-and-cost-tracking | Whether Langfuse is still outside the request path: its GitHub description on 2026-11-24 lists an "AI Gateway" (https://github.com/langfuse/langfuse). The live comparison page says it is not in the request path "by design"; that needs re-reading before it is repeated |
| OpenRouter | A 5.5% fee on credit purchases; own-key use free up to $25,000 a month, then 5%; no markup on inference prices. Passes provider prompt caching through; for Anthropic models the caller adds `cache_control`; sticky routing keeps a cache warm | https://openrouter.ai/docs/faq ; https://openrouter.ai/docs/features/prompt-caching | |
| Cloudflare AI Gateway | Exact-match response cache, disabled by default; semantic caching planned. Core features free; a 5% fee on Unified Billing credits | https://developers.cloudflare.com/ai-gateway/features/caching/ (modified 2026-09-30) ; https://developers.cloudflare.com/ai-gateway/reference/pricing/ (modified 2026-11-02) | |
| Vercel AI Gateway | No markup and no platform fee on tokens; optional surcharges are listed. `caching: 'auto'` adds cache breakpoints for Anthropic, MiniMax and Alibaba; it is opt-in; the page advises against it for strictly one-shot traffic | https://vercel.com/docs/ai-gateway/pricing (2026-09-08) ; https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching (2026-09-11) | |
| Requesty | `auto_cache` adds cache breakpoints; when unset, the default depends on the calling client. 5% on provider prices, 0% with own keys | https://docs.requesty.ai/features/auto-caching ; https://www.requesty.ai/pricing | |
| Bifrost (Maxim) | Response cache, exact and semantic, needing a cache-key header. "Code Mode" for MCP tools, with the vendor's own benchmark claiming up to 92.8% fewer input tokens. Apache-2.0 | https://docs.getbifrost.ai/features/semantic-caching ; https://docs.getbifrost.ai/mcp/code-mode ; https://github.com/maximhq/bifrost | No independent measurement found |
| TensorZero | Its site says it "remains available on GitHub but is no longer maintained". The repository was archived by its owner on 2026-06-12 | https://www.tensorzero.com/ ; https://github.com/tensorzero/tensorzero | Why |
| Not Diamond | $0.05 per million tokens routed | https://www.notdiamond.ai/pricing | Its savings claims were not read. On the RouterArena leaderboard (no date shown; 33 ranked entries) it is 29th and RouteLLM 32nd: https://github.com/RouteWorks/RouterArena. The live comparison page's "12th of 12" does not match what the leaderboard shows today |
| RouteLLM | Open-source router framework, Apache-2.0, not archived; last pushed 2024-08-10. Its README claims up to 85% lower cost at 95% of GPT-4 quality on one benchmark | https://github.com/lm-sys/RouteLLM | |
| Headroom | A local proxy and library that compresses tool outputs, logs and files; its README claims 20% fewer tokens for coding agents and 60 to 95% for JSON. Apache-2.0. The repository now lives at `headroomlabs-ai/headroom` | https://github.com/headroomlabs-ai/headroom | The independent replay on codepointer.dev that the live comparison page cites could not be opened (the host did not resolve on 2026-11-24), so its figures are unconfirmed today |
| RTK | A command-line proxy that rewrites command output for coding agents; claims 60 to 90% fewer tokens on common commands. The README gives Apache-2.0 for the CLI and BUSL-1.1 for the engine and proxy | https://github.com/rtk-ai/rtk | JetBrains' July 2026 test of it returned 403; its figures are unconfirmed today |
| LLMLingua | Prompt compression by a small model; claims up to 20x compression. MIT | https://github.com/microsoft/LLMLingua | |
| The Token Company | A hosted API that deletes low-value tokens from the input; claims 10 to 50% typically. Prompts are sent to its API. No price shown | https://thetokencompany.com/ | No independent measurement found |
| Compresr | A hosted context-compression API; claims up to 90% fewer tokens. No list price | https://compresr.ai/ | No independent measurement found |
| Edgee | Routing and token compression for coding agents. Free for one developer; Team $30 per seat a month | https://www.edgee.ai/pricing | Its savings claims were not on the page read |
| GPTCache | Semantic cache library, MIT, not archived. Its README says it no longer adds support for new APIs or models | https://github.com/zilliztech/GPTCache | |
| Martian, Unify | Neither home page mentions an LLM router today | https://withmartian.com/ ; https://unify.ai/ | Whether either still sells one. Do not compare |
| Kong AI Gateway | Not read for this revision | | Everything |

**What the providers do themselves** (each provider's own documentation, read
2026-11-24):

| Provider | What its pages said | Source |
|---|---|---|
| Anthropic | Prompt caching is opt-in on the Messages API. A cache read costs 0.1x the input price on most models, 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable and Mythos 5.1 and 5.2. A write costs 1.25x (5 minutes) or 2x (1 hour). One top-level `cache_control` field gives automatic caching with a breakpoint that moves forward; up to 4 explicit breakpoints; a lookback of 20 blocks. Changing tool definitions invalidates everything. The Batch API is 50% off. Tool search with `defer_loading` typically cuts definition tokens by over 85% on the page's five-server example of about 55,000 tokens. Context editing is in beta, and clearing invalidates the cached prefix | https://platform.claude.com/docs/en/build-with-claude/prompt-caching ; https://platform.claude.com/docs/en/about-claude/pricing ; https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ; https://platform.claude.com/docs/en/build-with-claude/context-editing |
| OpenAI | Prompt caching is on by default. On GPT-5.6 and later a read costs 0.1x or 0.05x by model, and a write is charged: 1.25x for 30 minutes, 2.5x for 12 hours. Earlier models have no write charge. The Batch API is 50% off. Flex is priced at Batch rates, is being wound down, and is not offered on GPT-6.2 Astra or Sol; no retirement date is given | https://developers.openai.com/api/docs/guides/prompt-caching ; https://developers.openai.com/api/docs/guides/batch ; https://developers.openai.com/api/docs/guides/flex-processing |
| Claude Code | Applies prompt caching and auto-compaction automatically, and defers MCP tool definitions by default | https://code.claude.com/docs/en/costs |

Unconfirmed on the Anthropic page: that caching has no effect on output. The
sentence was seen only in a tool's summary of the page, not in the text
returned. Open the page before saying it.

**Independent findings** (each read on 2026-11-24 at the URL given):

| Finding | Who, when | Source |
|---|---|---|
| The heaviest of three token-reduction setups cut delivered tool-output tokens 38.4% and raised billed cost 6.8%, on Claude Code coding tasks; token reduction and cost reduction correlated at r = 0.15 | Weinberger and Hozez, v5 of 2026-08-12 | https://arxiv.org/abs/2607.12161 (abstract) |
| Prompt caching cut API cost 41 to 80% across OpenAI, Anthropic and Google, over 500 agent sessions on one benchmark | Lumer and others, v2 of 2026-01-31 | https://arxiv.org/abs/2601.06007 (abstract) |
| 120 prompt-caching fixes in 10 open-source agent systems were studied; most failures are silent | Zhang and others, 2026-10-26 | https://arxiv.org/abs/2610.34817 (abstract) |
| A production agent's cache hit rate went from 7% to 84% and its cost fell 59% | ProjectDiscovery, 2026-04-10, on its own system | https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching |
| Token costs for users fell 7%; loading MCP tools on demand cut total tokens 46.9% in sessions that called one | Cursor, 2026-09-23, on its own product | https://cursor.com/blog/improved-token-efficiency |
| A wrapper cut MCP tool-description overhead by 70 to 97% | Atlassian, 2026-03-29, on its own tool | https://www.atlassian.com/blog/developer/mcp-compression-preventing-tool-bloat-in-ai-agents |

Unconfirmed for this revision: the first study's result for a proxy placed
the way Mesh is (reported from the paper's full text by the Command Center
on 2026-11-24; the abstract does not name the tools or give that figure); who
employs either paper's authors; the codepointer.dev replay and the JetBrains
tests, neither of which would load; the archestra.ai figure on the live
comparison page, which was not tried.

## The prompt panel, and how it is scored

`content/geo-prompt-set.json`, version 2, holds 45 questions. Each has an id,
an intent, who asks (human or agent), a workload, the page that should answer
it, and `honestAnswer`: `mesh`, `partly` or `not-mesh`. Fourteen are
`not-mesh`: questions where a correct answer names something else, kept so
that an engine wrongly describing Mesh (as a model router, say) shows up.

**How `evals/run-geo-visibility.ts` scores it.** The script queries nothing.
It reads observation rows that someone has collected and prints rates.

- **Observations file:** `evals/geo-observations.jsonl` unless another path
  is given as the first argument. The file does not exist. No observation has
  ever been recorded.
- **One row per question, per engine, per run:**
  `{"engine":"perplexity","promptId":"verify-cost-tool-saved-money","timestamp":"2026-12-01T09:00:00Z","mentioned":true,"cited":false,"linked":false,"correctDescription":true,"categoryAssociated":true,"competitorMentions":["litellm"],"citedDomains":["docs.litellm.ai"]}`.
  `promptId` is the question's `id` in the panel.
- **Rates** (`calculateGeoVisibilityMetrics` in
  `packages/core/src/geo-visibility.ts`): mention rate, citation rate and
  link rate, each over all rows; correct-description rate and
  category-association rate over the rows where Mesh was mentioned, and null
  when there are none, which means "no evidence yet" and not zero.
- **What it prints:** the overall row count with mention, citation and link
  rates, then the same three per engine. It does not print the
  correct-description rate, and it does not break anything down by question,
  intent, asker, workload or page.
- **So, to read the panel properly,** the rows are filtered by `promptId`
  before the script is run, and the script is run once per group. At the
  least: once for the questions tagged `mesh` or `partly`, where a mention is
  what is hoped for, and once for those tagged `not-mesh`, where a mention is
  a warning and `correctDescription` should be recorded false if Mesh is
  named as the answer. Per-page groups come from the `page` tag.

**What one measurement round costs.** A round asks every question several
times, because answers vary run to run; the playbook's floor is five runs per
engine. With four engines that is 45 x 5 x 4 = 900 questions asked. The 22
`core` questions alone are 22 x 5 x 4 = 440. A weekly round is that many each
week.

**What it needs.** Each question has to be put to an engine with its web
search on, which needs Harry's provider key or a search tool, and his
go-ahead. Nothing has been run. This revision ran nothing against any
provider or search API.

**What the nightly routine measures instead.** One web search per question in
`queries`, logged to `docs/metrics/geo/search-visibility.jsonl` on
`geo/nightly` with the fields `date`, `question`, `mesh_found`,
`mesh_position`, `top_domains` and `tool`. That is whether a search finds
Mesh, which is the precondition for being cited, and not whether an answer
engine names it. The script above does not read that file: its rows have no
`engine`, `promptId`, `timestamp` or `mentioned`. On its first two
nights (2026-11-24 and 2026-11-25, version 1 of the panel) the routine found
Mesh in 0 of 7 searches.

A visibility rate is a marketing measure. It is never quoted as evidence that
the product works.

## Still open

Found while revising. None is fixed here.

| Problem | Where | Whose |
|---|---|---|
| The canonical description is on a pushed branch, not yet on `main` | `gtm/claims-correction` at `c6acd5c` | The site-correction session, then Harry |
| The comparison page on `main` carries statements that could not be confirmed on 2026-11-24 (the corrected copy on `gtm/claims-correction` was not reviewed for them): the codepointer.dev and archestra.ai figures, "12th of 12" on RouterArena, Langfuse "not in the request path", prices "checked 2026-10-22", and nothing about Helicone's banner | `docs/site/comparison.md` | The site-correction session |
| `llms.txt` on `main` carries two figures that are not in `docs/NUMBERS.md`, and figures without their lever status. Two unmerged branches each rewrite it (`gtm/claims-correction` and `geo/nightly`) and will conflict | `docs/site/llms.txt` | The site-correction session and the Command Center |
| `docs/NUMBERS.md` says to lead with the 18.2% and does not record lever sets | `docs/NUMBERS.md` | Product and the Command Center |
| The site build has no place for these pages | `scripts/build-site.ts` | The Command Center |
| The brand profile used by the visibility package names a domain Mesh does not use and lists model routing and semantic caching as Mesh's mechanism | `packages/signal/src/mesh-profile.ts` | Product |
| The site has no analytics and no server logs, and is not known to be registered with Search Console or Bing Webmaster Tools | | Harry |
| The measurement round needs a key or a search tool | | Harry |
| The nightly routine's environment cannot reach the live site, so its audit is blocked | `docs/metrics/geo/NOTES-2026-11-24.md` on `geo/nightly` | The Command Center |
