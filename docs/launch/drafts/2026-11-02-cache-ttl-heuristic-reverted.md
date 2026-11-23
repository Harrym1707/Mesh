# We shipped a cache-TTL heuristic, then killed it four hours later with a bigger dataset

*(**Draft, not published.** Written 2026-11-02; the install path at the end
was checked again on 2026-11-23 against MESH 0.2.5 and is unchanged.
Publishing is the founder's act; retype it in your own words first.*

*Three percentages remain in this draft: 27.6%, 39.2% and 60.8%. None is a
MESH saving and none is in docs/NUMBERS.md. Each is a measurement on a public
dataset, made on 2026-10-27, and is sourced where it appears. The scripts
that produced them were kept in a scratch folder and are not in the
repository, so they can be read in the two findings files but not re-run
from the repo; decide whether that is good enough to publish them. The
per-workload savings percentages this draft used to carry were modelled on
the same public trace and are left out; the analysis file named at the end
has them.*

*Not verified: "four hours". The repository records the ship at 22:13:41 UTC
(`38a9a9e`) and the revert at 22:16:04 UTC (`40ab72a`) on 2026-10-27, about
two minutes apart, with the first findings file committed at 21:14 UTC.
Commit times are not the times the work was done, but nothing in the
repository supports four hours. Settle the title and the two sentences
that repeat it before publishing.)*

On 2026-10-27 we shipped `cacheTtl: "auto"` — a `CacheTtlAdvisor` that watches
a conversation's realized inter-arrival gaps and picks Anthropic's 5-minute
or 1-hour cache TTL for you instead of making you set a flag. The pitch: turns
that keep arriving inside 5 minutes stay on the cheap 1.25× write / 0.1× read
tier; turns that regularly arrive after a 5-minute entry would have expired
get promoted to the 1-hour, 2.0× write tier, because re-paying full input
every time is worse than the pricier write. Ten advisor tests, 65 existing
cache/reduce tests green, shipped.

Four hours later we reverted it. Here's what happened in between.

## The calibration that shipped it

The threshold came from a real public trace — Mooncake's one-hour serving
log — split into two workload shapes. Tool-agent turns showed a reuse-gap
p90 of 243 seconds; conversation turns showed p90 519 seconds. WildChat
corroborated the shape: in a sample of 995 conversations from the public
WildChat-1M dataset, 27.6% of the 1,767 gaps between turns were longer than
300 seconds, so a 5-minute cache entry would have expired (a dataset
measurement of 2026-10-27, not a MESH saving;
`docs/rnd/knowledge/2026-10-27-dataset-findings.md`, commit `bdd232d`). The
rule we shipped: default to 5-minute caching, and
promote a whole workload to 1-hour once its *realized gap p90* crosses 300
seconds. Conversation traffic (519s) qualified; tool-agent traffic (243s)
didn't. That felt like a clean, data-backed split, and it passed every test
we had for it.

The problem is we only had one hour of trace to calibrate against.

## The re-run that broke it

The same evening, as part of a standing habit of re-running every lever at a
much larger sample before trusting it, we pulled the full Mooncake trace,
a full week of Azure's 2024 LLM inference log (~2.9M requests), a 10×-larger
SWE-rebench slice, and four more agent corpora we hadn't looked at yet. Most
of what we'd shipped held up almost exactly — the 200→500 token threshold for
compacting tool results, the 1024/2048-token cacheable-minimum split, the
history-retention gates. The TTL heuristic did not.

The p90-gap trigger measures *coverage*: what fraction of reuse gaps a given
TTL catches. It never prices the write premium you pay on every cacheworthy
block to get that coverage, including the large majority of blocks that have
no gap anywhere near the 300–3600 second range in the first place. Once we
priced it — Anthropic's actual 1.25× write for 5-minute, 2.0× write for
1-hour, 0.1× read, 1.0× for an uncached block — flat-1h loses to flat-5m on
every workload we measured in the full Mooncake trace: conversation (44,144
cacheworthy blocks), tool-agent (39,481) and synthetic (18,251). A
hypothetical per-block oracle beats both on all three.

Conversation traffic — the workload our own heuristic promoted to 1-hour —
comes out worse for taking that promotion. The reason: of the 44,144
cacheworthy conversation blocks in the full Mooncake trace (blocks used at
least twice), only 39.2% ever have a reuse gap that lands in the window
where 1-hour helps (between 300 seconds and the trace's 1-hour horizon). The
other 60.8% pay the 2.0× write tax with no reuse gap in that window. Both
figures describe the public trace, measured on 2026-10-27; they are not MESH
savings (`docs/rnd/knowledge/2026-10-27-dataset-findings-run2.md`, commit
`62e41cd`). A workload-level average gap, however carefully measured, can't see that split
— it's a property of individual prefixes, not of the workload they came from.

The "oracle per-block" column is the real target: a hypothetical advisor that
knows, for each specific prefix, whether its *next* reuse will land past 300
seconds, and only pays the 1-hour premium for that one. On this public trace
it beats flat-5m on all three workloads —
there's real money in getting TTL promotion right. We just shipped the wrong
mechanism for finding it. The commit message for the larger run (`62e41cd`)
says it plainly: "The lever I shipped earlier is reverted; correct design is
per-prefix adaptive promotion, re-queued for careful build."

## What we're building instead

Per-prefix adaptive promotion: track each individual cache breakpoint's own
observed gap history, and promote *that prefix* to 1-hour only after it has
already shown a gap longer than 300 seconds that still got reused. No
workload-level p90, no averaging across prefixes that behave nothing alike.
It's a harder thing to build correctly — it needs per-prefix state instead of
a single conversation-level counter — so it's back in `docs/rnd/lever-backlog.md`
queued for a careful build rather than a same-day ship.

Nothing on by default was wrong: `cacheTtl: "auto"` was behind a flag
nobody was defaulted into, and the flat `"5m"`/`"1h"` options were never
touched. What this cost us was four hours of
engineering time and a slightly embarrassing revert commit. What it would
have cost us, left unreverted, is billing 1% of a saving that the write
premium had already eaten. We'd rather catch that in our own R&D re-run than
in anyone's invoice — which is the entire reason the re-run exists as a
standing step before anything we ship gets trusted at the next tier of
traffic.

The commits are `38a9a9e` (ship), `62e41cd` (the larger-n run that falsified
it), and `40ab72a` (revert) if you want to read the diff and the dataset
analysis yourself — `docs/rnd/knowledge/2026-10-27-dataset-findings-run2.md`
has the full breakdown, including the three other findings that *did* survive
the larger sample.

To run MESH on your own traffic (open to anyone, no signup): install with
`curl -fsSL https://www.mesh-technology.com/install.sh | sh` (macOS, Linux,
or inside WSL on Windows) or `npm install -g @harrym1707/mesh`; then
`mesh start` for Claude Code, or `mesh proxy` for your own app with
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`; then `mesh verify`. Questions:
https://github.com/Harrym1707/Mesh/issues/new
