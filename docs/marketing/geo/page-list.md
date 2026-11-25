# GEO page list

Every page the GEO programme plans, in the order to write them. The rules,
the template and the writer-then-checker routine are in
[`../geo-programme.md`](../geo-programme.md). The questions are in
[`content/geo-prompt-set.json`](../../../content/geo-prompt-set.json); each
page names the ids it answers.

Written 2026-11-24 against `main` at `e20a187` (release 0.2.5); re-checked
2026-11-25 against `main` at `784dd82`. No page has been written. Nothing
here is published.

**How to read an entry.** "Brief" is what the writer is held to: the answer
the first paragraph must give, the evidence, the Mesh figures the page may
use, and where Mesh loses. "Sources to open on the day" must be opened by the
writer on the day of writing and by the checker on the day of checking;
nothing in this file is a substitute for doing that. "Why here" is the reason
for its place in the order: demand, Mesh's honest right to answer, and whether
it waits on something that has not shipped.

**Figures a brief may name** are only the four whose lever sets are recorded
in the programme. Each must be written with its label, date, `docs/NUMBERS.md`
and lever status in the same sentence. No page uses a percentage for a fresh
install: none exists.

**The canonical description** every page uses is quoted in the programme. On
2026-11-25 it was on the pushed branch `gtm/claims-correction` and not yet on
`main`; a page checked before it is merged is re-checked against the merged
wording before it is published.

## Status

| # | Slug | Status | Raw draft used |
|---|---|---|---|
| 1 | `verify-llm-savings-claims` | **Write now** | none |
| 2 | `prompt-caching-for-agents` | **Write now** | none |
| 3 | `what-llm-cost-tools-do-out-of-the-box` | **Write now** | none |
| 4 | `token-reduction-vs-cost-reduction` | Next | none |
| 5 | `llm-cost-tool-pricing-models` | Queued | none |
| 6 | `mcp-tool-definition-tokens` | Queued | none |
| 7 | `cost-proxy-for-claude-code` | Queued | none |
| 8 | `cut-claude-api-cost-for-agents` | Queued | none |
| 9 | `mesh-vs-litellm` | Queued | none |
| 10 | `alternatives-to-helicone` | Queued | none |
| 11 | `alternatives-to-portkey` | Queued | none |
| 12 | `risks-of-an-llm-proxy` | Queued | none |
| 13 | `batch-and-flex-for-agents` | Queued | none |
| 14 | `cut-openai-api-cost-for-agents` | Held | none |
| 15 | `multi-agent-cost` | Held | none |
| 16 | `rag-support-browsing-agent-cost` | Held | none |
| 17 | `operate-mesh-from-an-agent` | Held | none |
| 18 | `mesh-out-of-the-box-savings` | Held | none |

Panel questions answered by a page that already exists under `docs/site/`,
which the site-correction session owns: `mesh-cost-if-nothing-saved` (the
pricing page), `agent-base-url-local-proxy` and `agent-install-mesh-verify`
(the start page), `mesh-proven-on-real-traffic` (the evidence page). No new
page is planned for them.

Panel questions with no page at all: `route-by-cost-and-quality` and
`switch-traffic-to-cheaper-models`. Mesh does not route between models and
has no data of its own on routing, so it has nothing to add to that question.

---

## The first three: write these now

None depends on `mesh mcp`, on a fresh-install figure, or on anything
unreleased. Each rests on what is on `main` today and on sources that opened
on 2026-11-24.

### 1. `verify-llm-savings-claims`

**Title:** How do I verify that an LLM cost tool actually saved me money?

**Answers:** `verify-cost-tool-saved-money`,
`check-vendor-claim-against-invoice`, `agent-verify-savings-baseline`,
`recompute-savings-invoice`.

**Brief.** The first paragraph says: a savings claim is only as good as its
baseline, so check three things, whoever the vendor is. What you actually
paid, from the provider's own usage and invoice. What you would have paid,
and whether that is measured or estimated. And whether the task still
succeeded, because a cheaper request that needs two more turns is not a
saving. Then the method in steps a reader can follow for any tool: get the
provider's usage export; ask for per-request records, not a dashboard total;
ask how the "before" was produced; compare billed cost per completed task
across a period with the tool on and off, since token counts are not cost.

Evidence: the independent study in which a 38.4% cut in tool-output tokens
came with a 6.8% rise in billed cost, and token and cost reduction barely
correlated (arXiv 2607.12161). Say who measured it and on what (Claude Code
coding tasks), and that it tested other tools, not Mesh.

What Mesh does today, exactly: it writes one hash-chained record per request
to a ledger on the customer's own disk; `mesh verify` re-checks the chain and
recomputes the invoice with no network call; `mesh statement --period
YYYY-MM` rebuilds a month and signs it with that install's key; if the
customer's recomputation differs from Mesh's for the same ledger, the
customer's stands. The writer reads `packages/cli/src/verify.ts`,
`packages/cli/src/statement.ts` and `docs/site/methodology.md` and describes
only what they do.

Figures: none is needed. If the 18.2% LIVE figure (run 2026-10-26,
`docs/NUMBERS.md`, measured with the Anthropic cache stamp and a
gate-approved tool-result cap switched on, neither of which a fresh install
applies) is used at all, it is as an example of a ledger anyone can recompute
from the committed spools, and it is described as a 30-request basket Mesh
wrote itself.

Where Mesh loses, said plainly: Mesh's "would have paid" for a removed token
is an estimated baseline, priced from what Mesh removed; its statement
labels it so. It is not a controlled comparison of billed cost per task with
Mesh on and off, and that is the test the study above says matters. Nobody
has run that test on Mesh. Mesh has no customers and has never run on a
customer's traffic. A team that wants to see spend by feature, user or trace
needs an observability tool, which Mesh is not. A team with one provider and
simple traffic can do this check with the provider's own usage export and a
spreadsheet.

**Sources to open on the day:**
https://arxiv.org/abs/2607.12161 (and its full text, for what was tested);
https://platform.claude.com/docs/en/about-claude/pricing ;
https://developers.openai.com/api/docs/guides/prompt-caching (how cached
tokens are reported and priced); https://langfuse.com/pricing and
https://langfuse.com/docs/observability/features/token-and-cost-tracking and
https://www.helicone.ai/ if either is named as an alternative.

**Why here.** It is the one question where Mesh has something no page in
today's search results has: a method the reader can run, and a product built
around it. It needs no savings figure. The Go-to-market direction is to lead
with it.

### 2. `prompt-caching-for-agents`

**Title:** How do I get prompt caching to actually hit for an agent on the
Claude or OpenAI API?

**Answers:** `anthropic-cache-hit-agent-loop`,
`low-cache-hit-rate-cache-control`, `agent-cache-read-zero`,
`openai-caching-automatic`, `proxy-add-caching-no-code`,
`caching-costs-more-than-saves`, `cost-per-step-grows`,
`rag-same-context-cost`.

**Brief.** The first paragraph says: a cache hits only when the start of the
request is byte-for-byte the same as last time, so keep everything that
changes (timestamps, ids, per-user values, retrieved text) after everything
that does not, put the breakpoint after the stable part, and watch
`cache_read_input_tokens`; on the Claude API caching is off until you ask
for it, on the OpenAI API it is on by default. Most readers can do this with
the provider's own features and no tool.

Then, from each provider's own page on the day: the read and write prices;
Anthropic's one-field automatic mode and its limits (four breakpoints, the
20-block lookback); what invalidates a cache; that newer OpenAI models charge
for cache writes; when caching loses money (a write that is never read; a
prefix that changes every turn; strictly one-shot traffic).

Evidence: the 41 to 80% range across three providers over 500 agent sessions
(arXiv 2601.06007); the study of silent caching mistakes in open-source agent
systems (arXiv 2610.34817); one production account of a hit rate going from
7% to 84% (ProjectDiscovery). Each is someone else's system, not Mesh.

What Mesh does today, in two lists. A fresh install: cache-prefix repair,
described from `packages/sdk-js/src/reduce-request.ts` as the code has it,
with no figure. Only when switched on: the Anthropic cache stamp
(`cache-ttl-5m`, `cache-ttl-1h`), which places the breakpoint and declines
to stamp a prefix that keeps changing. The writer must show, from the code
and `docs/guide/configure.md`, exactly how the stamp is switched on in
0.2.5, and if that cannot be shown working, say so in the pull request and
leave it out.

Figures the page may use: the 37.9% SIMULATOR figure (commit `6f08b72`,
`docs/NUMBERS.md`, reconciled 2026-10-27), which was modelled with the
Anthropic cache stamp switched on, a lever a fresh install leaves off; and
the 34.3% SIMULATOR figure (same commit and file), modelled with the J stack
(six levers, listed in the programme) plus the 1-hour stamp switched on, most of which a fresh install leaves off. Both are simulations
against a stack with caching off, not a bill.

Where Mesh loses: the provider's own automatic caching covers the ordinary
case with one field; several gateways add breakpoints too (the page checks
LiteLLM, Vercel, OpenRouter and Requesty on the day); a team already hitting
its cache gains nothing from a second tool; on the OpenAI API, where caching
is automatic, Mesh has not been measured against that baseline; and Mesh's
cache stamp is off unless the reader switches it on.

**Sources to open on the day:**
https://platform.claude.com/docs/en/build-with-claude/prompt-caching ;
https://platform.claude.com/docs/en/about-claude/pricing ;
https://developers.openai.com/api/docs/guides/prompt-caching ;
https://arxiv.org/abs/2601.06007 ; https://arxiv.org/abs/2610.34817 ;
https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching ;
https://docs.litellm.ai/docs/tutorials/prompt_caching ;
https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching ;
https://openrouter.ai/docs/features/prompt-caching ;
https://docs.requesty.ai/features/auto-caching .

**Why here.** It is the lever with the strongest independent evidence, eight
panel questions land on it, and the reader's agent can act on the page
without installing anything. Mesh's own part is small and can be said
exactly. Nothing unreleased is needed.

### 3. `what-llm-cost-tools-do-out-of-the-box`

**Title:** What does an LLM cost tool actually do before you configure
anything?

**Answers:** `cost-tool-before-configuration`,
`tools-reduce-cost-same-output`, `drop-in-proxy-prompts-local`,
`agent-local-lossless-proxy`, `gateways-compared-for-cost`.

**Brief.** The first paragraph says: less than the landing pages suggest. In
most gateways every cost feature is off until it is configured, and the
biggest lever, prompt caching, is usually the reader's to switch on; so the
useful question about any tool is what it does on a fresh install and what
it does only after a setting is changed.

Then one table, each cell from the vendor's own documentation on the day:
for each tool, what is on by default, what must be switched on, where
prompts go, and the price. Rows as planned today: Mesh, LiteLLM, Helicone,
Portkey, OpenRouter, Cloudflare AI Gateway, Vercel AI Gateway, Requesty, and
the provider's own API. A cell the vendor's page does not answer says
"unconfirmed".

The Mesh row, from `defaultPolicy` in `packages/sdk-js/src/theo-policy.ts`:
on a fresh install, three levers classed lossless (tool-schema compaction,
duplicate-context removal, cache-prefix repair), a ledger on the customer's
disk, prompts not sent to Mesh. Off until switched on: the Anthropic cache
stamp, the tool-result cap, JSON tool-result compaction, the flex tier,
output effort. No response cache, no model routing, no observability
dashboard beyond its own local one.

Figures: no percentage for the Mesh row's defaults; none exists, and the
page says so in words: "Mesh publishes no savings figure for a fresh
install." The 18.2% LIVE figure (run 2026-10-26, `docs/NUMBERS.md`) may
appear only as an example of the gap, stated as measured with the Anthropic
cache stamp and a gate-approved tool-result cap switched on, which a fresh
install does not apply.

Where Mesh loses: its largest measured lever is off by default; where an
app already caches, the default levers act mostly on text in the cached part
of the request, which the provider bills at a fraction of the input price; a
reader who needs
routing, response caching, budgets or tracing needs one of the other rows;
Mesh is a single-founder product with no customers.

**Sources to open on the day:**
https://docs.litellm.ai/docs/tutorials/prompt_caching ;
https://docs.litellm.ai/docs/proxy/caching ;
https://docs.litellm.ai/docs/mcp_tool_search ; https://www.litellm.ai/ ;
https://www.helicone.ai/ ; https://www.helicone.ai/pricing ;
https://docs.helicone.ai/features/advanced-usage/caching ;
https://portkey.ai/ ;
https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic ;
https://openrouter.ai/docs/faq ;
https://openrouter.ai/docs/features/prompt-caching ;
https://developers.cloudflare.com/ai-gateway/features/caching/ ;
https://developers.cloudflare.com/ai-gateway/reference/pricing/ ;
https://vercel.com/docs/ai-gateway/pricing ;
https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching ;
https://docs.requesty.ai/features/auto-caching ;
https://www.requesty.ai/pricing ;
https://platform.claude.com/docs/en/build-with-claude/prompt-caching ;
https://developers.openai.com/api/docs/guides/prompt-caching .

**Why here.** It is the figures correction turned into a page: it states
Mesh's defaults truthfully before anyone else describes them wrongly, and
the same table is original, dated material about every tool in it. It names
Helicone and Portkey, so it must quote their own pages as read that day and
say nothing about their ownership beyond what those pages say.

---

## Next, one a week

### 4. `token-reduction-vs-cost-reduction`

**Title:** Does compressing prompts or tool output actually lower an LLM
bill?

**Answers:** `fewer-tokens-lower-bill`, `compression-lowers-bill`,
`rtk-headroom-claude-code`.

**Brief.** First paragraph: often not. On an agent that already caches, most
input is billed at the cache-read price, so removing it saves little, and
changing what the agent sees can cost extra turns or a cache rewrite; one
controlled study measured a 38.4% cut in tool-output tokens alongside a 6.8%
rise in billed cost. Evidence: that study (arXiv 2607.12161), read in full,
including what it found for a proxy set through the base URL, which is how
Mesh is placed; Cursor's own account of what its token work was worth
overall. The vendors' own claims for Headroom and RTK, from their
repositories, beside the measurements, each dated.

What Mesh does today: its three default levers remove or rewrite text
without changing what it decodes to; that is token reduction, and the page
says so and says no measurement of Mesh's effect on billed cost per task
exists. No Mesh figure is used.

Where Mesh loses: this page is mostly a warning that applies to Mesh too. A
reader on Claude Code should probably use nothing. A reader whose waste is
one oversized tool output can fix it in their own tool.

**Sources to open on the day:** https://arxiv.org/abs/2607.12161 and its
full text; https://cursor.com/blog/improved-token-efficiency ;
https://github.com/headroomlabs-ai/headroom ; https://github.com/rtk-ai/rtk ;
https://platform.claude.com/docs/en/build-with-claude/prompt-caching (read
prices). If they load: the codepointer.dev replay and JetBrains' July 2026
RTK test, neither of which loaded on 2026-11-24; a figure from either is
used only if the primary page opens.

**Why here.** High demand and strong independent evidence, and it is the
page that keeps Mesh from being described as a compressor. It comes after
the first three because it is partly a statement against Mesh's own default
levers, and reads better once the pages saying what Mesh is for exist. It
would be stronger with a measured test of Mesh; it does not wait for one.

### 5. `llm-cost-tool-pricing-models`

**Title:** How do LLM cost tools and gateways charge: markup, seats, or a
share of savings?

**Answers:** `agent-pricing-share-of-savings`, `gateway-fees-compared`.

**Brief.** First paragraph: four models are in use, a fee on credits or
tokens, a flat or per-seat subscription, a per-token routing fee, and a
share of measured savings; which is cheapest depends on spend and on whether
the tool saves anything. One table of prices, each from the vendor's pricing
page on the day. Mesh's row is the fee statement, word for word, and "free
to install and run". The page may show what each model costs at a stated
monthly spend as arithmetic on the vendors' published rates, labelled as
arithmetic; it shows no Mesh saving.

Where Mesh loses: a share of savings is only as trustworthy as the baseline
(link to page 1); a flat fee is simpler to budget; a free self-hosted
gateway costs nothing; Mesh does not take payment automatically and bills
only by written agreement. The page does not say Mesh is the only tool
priced this way: that cannot be confirmed. It may say none of the vendors
in its own table is, if their pages show that on the day.

**Sources to open on the day:** https://openrouter.ai/docs/faq ;
https://developers.cloudflare.com/ai-gateway/reference/pricing/ ;
https://vercel.com/docs/ai-gateway/pricing ; https://www.requesty.ai/pricing ;
https://www.notdiamond.ai/pricing ; https://www.helicone.ai/pricing ;
https://langfuse.com/pricing ; https://www.litellm.ai/ ;
https://www.edgee.ai/pricing ; https://portkey.ai/pricing (redirected to a
contact page on 2026-11-24: "unconfirmed" unless a price is shown).

**Why here.** Price is one of the facts engines weigh most, Mesh's is simple
and fully its own to state, and every other row opened cleanly on
2026-11-24. It follows page 1 because it leans on it.

### 6. `mcp-tool-definition-tokens`

**Title:** How many tokens do MCP tool definitions use, and how do you cut
them?

**Answers:** `mcp-tool-definition-tokens`, `agent-mcp-defer-loading`.

**Brief.** First paragraph: tool definitions are sent on every request, so a
few MCP servers can add tens of thousands of tokens; the fix that works is
loading definitions on demand, which the providers and several clients now
do, and it is worth checking first whether those tokens are already cached,
because then they are billed at a fraction of the input price. Evidence from
each source on the day: Anthropic's tool search and its worked example;
Claude Code deferring MCP definitions by default; Cursor's on-demand
loading; Atlassian's wrapper; LiteLLM's tool search; Bifrost's code mode,
labelled as the vendor's own benchmark.

What Mesh does today: tool-schema compaction on a fresh install, described
from the code, with no figure (none is in `docs/NUMBERS.md` for it). Mesh
does not defer or search tools.

Where Mesh loses: on this question, almost entirely. Deferral removes most
of the definitions; Mesh only makes each one smaller.

**Sources to open on the day:**
https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ;
https://code.claude.com/docs/en/costs ;
https://cursor.com/blog/improved-token-efficiency ;
https://www.atlassian.com/blog/developer/mcp-compression-preventing-tool-bloat-in-ai-agents ;
https://docs.litellm.ai/docs/mcp_tool_search ;
https://docs.getbifrost.ai/mcp/code-mode .

**Why here.** A specific, common question with clean primary sources. Mesh's
right to answer is modest, which is why it is not earlier; it is honest
ground to be found on.

### 7. `cost-proxy-for-claude-code`

**Title:** Do you need a cost proxy for Claude Code?

**Answers:** `cost-proxy-for-claude-code`.

**Brief.** First paragraph: probably not. Claude Code already applies prompt
caching, compacts long conversations and defers MCP tool definitions, so
there is little left for a proxy to remove, and one study found token
reducers raising its billed cost. Then what does help, from Anthropic's own
cost page. What Mesh does with Claude Code (`mesh start`), and that Mesh is
built for teams calling the API from their own agents. No Mesh figure.

Where Mesh loses: this whole page.

**Sources to open on the day:** https://code.claude.com/docs/en/costs ;
https://arxiv.org/abs/2607.12161 .

**Why here.** Many people ask it, and the honest answer protects Mesh from
the wrong users and the wrong reviews. It is short and depends on nothing.

### 8. `cut-claude-api-cost-for-agents`

**Title:** How do you cut Claude API costs for an agent that calls the API
constantly?

**Answers:** `cut-claude-cost-agent`, `reduce-agent-inference-costs`,
`agent-reduce-input-cost-loop`.

**Brief.** First paragraph: in order of evidence, get the prompt cache to
hit, move work that can wait to the Batch API, load tool definitions on
demand, and choose model and effort per task; measure billed cost per
completed task, not tokens. Each step links to the page that covers it
(pages 1, 2, 4, 6, 13) and to the provider's own documentation. What Mesh
does today, as on page 3. Figures: at most the 18.2% LIVE figure (run
2026-10-26, `docs/NUMBERS.md`, measured with the Anthropic cache stamp and
a gate-approved tool-result cap switched on, which a fresh install does not
apply), described as a basket Mesh wrote itself.

Where Mesh loses: most of the list is the provider's own features; model
choice and routing are not Mesh's.

**Sources to open on the day:**
https://platform.claude.com/docs/en/build-with-claude/prompt-caching ;
https://platform.claude.com/docs/en/build-with-claude/batch-processing ;
https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ;
https://platform.claude.com/docs/en/about-claude/pricing ;
https://arxiv.org/abs/2601.06007 .

**Why here.** The highest-demand question in the panel, and the most
crowded: on 2026-11-24 the nightly routine's searches for questions like it
returned vendor listicles and no Mesh page. A hub is only worth writing once
the pages it links to exist, so it follows them.

### 9. `mesh-vs-litellm`

**Title:** Mesh or LiteLLM: which do you need for controlling LLM spend?

**Answers:** `alternatives-to-litellm`.

**Brief.** First paragraph: they do different jobs. LiteLLM is a gateway to
many providers with budgets, keys, routing and optional caching; Mesh is a
local proxy that applies a few request-level levers and keeps a ledger the
customer can recompute. Most teams that need a gateway need LiteLLM or
something like it, and can run Mesh as well or not at all. The comparison
table from LiteLLM's own pages on the day. Mesh's earlier test of LiteLLM
v1.106.4's cache placement is used only if it is re-run on the current
LiteLLM version first, with the captures committed; otherwise it is left
out.

Where Mesh loses: breadth, routing, budgets, virtual keys, maturity,
community, and a free MIT-licensed core.

**Sources to open on the day:** https://www.litellm.ai/ ;
https://docs.litellm.ai/docs/tutorials/prompt_caching ;
https://docs.litellm.ai/docs/proxy/caching ;
https://docs.litellm.ai/docs/mcp_tool_search ;
https://github.com/BerriAI/litellm (licence files).

**Why here.** LiteLLM is the tool Mesh is most often set beside, and its
pages are clear. It is not earlier because pages 3 and 5 already carry the
facts most readers want, and because the one empirical claim needs a re-run.

### 10. `alternatives-to-helicone`

**Title:** What are the alternatives to Helicone?

**Answers:** `alternatives-to-helicone`, `is-helicone-still-developed`.

**Brief.** First paragraph: it depends what Helicone was doing for you:
tracing and cost tracking, a hosted gateway, or response caching; name the
real alternatives for each from their own pages. Mesh is not an
observability platform and is an alternative for none of the three; it does
something adjacent, and the page says that in one paragraph. On Helicone's
status the page quotes Helicone's own site as read that day and nothing
else.

Where Mesh loses: every use Helicone is bought for.

**Sources to open on the day:** https://www.helicone.ai/ (the banner);
https://www.helicone.ai/pricing ; https://www.helicone.ai/blog ;
https://docs.helicone.ai/ ; https://github.com/Helicone/helicone ;
https://www.mintlify.com/blog/mintlify-acquires-helicone (a third party's
statement, to be attributed to Mintlify with its date, never restated as
Helicone's own); https://langfuse.com/pricing ; https://www.litellm.ai/ .

**Why here.** People do ask it. But Mesh's right to answer is weak, and the
facts are unsettled: on 2026-11-24 Helicone's home page said it is "now part
of Experiential Labs" with details to come, which is not what the market
review reported. Writing it later lets the vendor's own account settle.

### 11. `alternatives-to-portkey`

**Title:** What are the alternatives to Portkey's AI gateway?

**Answers:** `alternatives-to-portkey`.

**Brief.** First paragraph: the alternatives are other gateways, named from
their own pages; Mesh is not a multi-provider gateway and is not one of
them. What Portkey's own site says it is today, quoted and dated. One
paragraph on what Mesh does instead.

Where Mesh loses: routing, fallbacks, guardrails, governance.

**Sources to open on the day:** https://portkey.ai/ ;
https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic ;
https://github.com/Portkey-AI/gateway ;
https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents ;
https://www.litellm.ai/ ; https://openrouter.ai/docs/faq ;
https://vercel.com/docs/ai-gateway/pricing ;
https://developers.cloudflare.com/ai-gateway/reference/pricing/ .

**Why here.** Same reasoning as page 10: asked for, but Mesh is not the
answer, and Portkey's pricing could not be read on 2026-11-24.

### 12. `risks-of-an-llm-proxy`

**Title:** What are the risks of putting a proxy between your app and the
OpenAI or Anthropic API?

**Answers:** `risks-of-third-party-proxy`, `proxy-sees-prompts-and-key`.

**Brief.** First paragraph: a proxy sees every prompt and your API key in
transit, adds a hop that can fail or slow a request, and can change what is
sent; so ask where it runs, what it stores, what happens when it is down,
and how to remove it. Then those questions answered for Mesh from the code
and `docs/guide/data-and-privacy.md`: it runs on the customer's machine,
what the ledger holds, what `--capture` writes when switched on, how the
runtime updates itself and how to stop that, how `mesh uninstall` and `mesh
restore` undo it, the licence. A latency figure is used only if the writer
re-runs `evals/run-proxy-overhead.ts` and the checker confirms the row on
`docs/site/evidence.md`; it is a measurement on one machine and is said to
be.

Where Mesh loses: it is one more moving part; it is young, has no customers
and one founder; a hosted gateway comes with a company behind its uptime.

**Sources to open on the day:** the code and guide named above; the Terms
and Privacy pages under `docs/site/`.

**Why here.** A buyer's agent will ask it before recommending an install.
It needs no competitor facts. It follows the pages that say what Mesh is.

### 13. `batch-and-flex-for-agents`

**Title:** Can agent workloads use the Batch API or flex processing to
halve cost?

**Answers:** `batch-flex-for-agents`.

**Brief.** First paragraph: only the parts nobody is waiting for. Both
providers discount batch work by half; OpenAI's flex tier is priced the same
and is being wound down. What Mesh does: a flex lever that is off unless
switched on. Figure the page may use: the 57.7% net SIMULATOR figure (commit
`4e51734`, `docs/NUMBERS.md`, reconciled 2026-10-27), modelled with the J
stack plus the provider's flex tier switched on, which a fresh install does
not apply.

Where Mesh loses: this is the provider's feature, and one request field.

**Sources to open on the day:**
https://platform.claude.com/docs/en/build-with-claude/batch-processing ;
https://developers.openai.com/api/docs/guides/batch ;
https://developers.openai.com/api/docs/guides/flex-processing .

**Why here.** Clean sources, low demand, little of Mesh in it.

---

## Held

Each waits on something that does not exist yet. Do not write one until its
"Held until" is true, and do not mention the thing it waits for on any other
page.

### 14. `cut-openai-api-cost-for-agents`

**Answers:** `cut-openai-cost-agents`. **Held until** Mesh has been measured
against OpenAI's automatic caching. Today it has not, so the page could only
restate OpenAI's documentation.

### 15. `multi-agent-cost`

**Answers:** `multi-agent-expensive-cache`. **Held until** Mesh ships
something for sub-agent fan-out and it has been measured, or the Go-to-market
chat decides the page is worth writing as an answer that is not Mesh.

### 16. `rag-support-browsing-agent-cost`

**Answers:** `support-bot-cost-per-ticket`, `browser-agent-page-snapshots`.
**Held until** a measured test on one of those workloads exists. The market
review found almost no published evidence for them, and Mesh has none of its
own beyond rows in a basket it wrote itself.

### 17. `operate-mesh-from-an-agent`

How an agent installs, checks, reads and removes Mesh by itself. **Held
until** the agent-readable interface it would describe is released.

### 18. `mesh-out-of-the-box-savings`

**Held until** `docs/NUMBERS.md` carries a figure for a fresh install. It
does not, and no page may state one.

---

## What the market reviews said that could not be confirmed

The two market reviews of 2026-11-23 were used for the comparison entries
above. Their status is unverified. Re-opened at the primary source on
2026-11-24, these did not hold, or could not be checked:

| Claim in a review | What was found on 2026-11-24 |
|---|---|
| Helicone was acquired by Mintlify and is in maintenance mode | Mintlify's post of 2026-03-03 says so. Helicone's own home page says "now part of Experiential Labs. Details to come soon."; its pricing, blog index and docs home say nothing of either. Two Helicone URLs for the announcement return 404. Unconfirmed; not to be stated |
| The codepointer.dev replay: three token trimmers saved 3.7% of spend combined | The host did not resolve. Unconfirmed today |
| JetBrains' tests of RTK and of a terse-output skill | The post returned 403. Unconfirmed, as the review itself said |
| The archestra.ai figures (about 77% modelled, about 13% in production) | Not tried; the review reports the page returned 404 |
| A proxy placed like Mesh raised billed cost 48.4% in the PointFive study | The arXiv abstract page does not name the tools or give that figure. The Command Center reports reading it in the full text on 2026-11-24. A writer opens the full text |
| The two studies are by PointFive and PwC authors | Affiliations are not on the abstract pages read |
| Portkey's prices | `portkey.ai/pricing` redirects to a Palo Alto Networks contact page |
| No LLM cost product bills a share of verified savings | A negative; cannot be confirmed. No page says Mesh is the only one |
| Langfuse is never in the request path | Its repository description now lists an "AI Gateway". Needs re-reading |
| Anthropic states that caching does not change output | Seen only in a tool's summary of the page |
| Kong, Sapiom, Codag, Condense, Mastra, LangChain, Hex, Draup, PostHog and GitHub Copilot entries; Requesty's cache-share data | Not re-opened for this list |

Confirmed on 2026-11-24 at the vendor's own page, and usable with that
source and date: Portkey's home page calls it "PRISMA AIRS AI Gateway" and
names Palo Alto Networks; TensorZero's site says it is no longer maintained
and its repository was archived on 2026-06-12; the RouterArena leaderboard
lists 33 ranked entries with Not Diamond 29th; and every price and default
in the programme's comparison table that carries no "unconfirmed" note.
