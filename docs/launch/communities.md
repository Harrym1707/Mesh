# Communities — where Mesh launches, in what order, in whose language

**Draft plan; nothing here has been posted.** Refreshed 2026-11-24 for Mesh
0.2.5.

The one-page view. Research: research/hackernews.md, research/reddit.md,
research/channels.md. Posts: show-hn.md, reddit-posts.md, other-channels.md.

## Who it is for (set 2026-11-23)

Teams running their own agents on the API: coding agents, browsing agents,
support, RAG, multi-agent loops. Not Claude Code users as such: Claude Code
already manages its own prompt cache, so on a fresh install they should
expect little, and every post that reaches them says so without putting a
number on it.

That changes the order. The venues where agent builders are come first:
Hacker News, r/LLMDevs, r/mlops, and comments in r/AI_Agents and r/OpenAI.
The two Claude subs were the planned first Reddit venues; r/ClaudeAI is now
optional and only as a teaching post for people who call the API, and
r/ClaudeCode is held. Neither draft is deleted; both are marked in
reddit-posts.md with the reason.

## The sequence

| Week | Action | Venue | Register to write in |
|---|---|---|---|
| Now | Create AlternativeTo account (must age 7 days); start commenting (no links) in r/LLMDevs, r/AI_Agents and r/mlops; post occasionally from the HN account if it's fresh | — | Helpful engineer, zero promo |
| Done | The MIT-verifier split: `@harrym1707/verify` (MIT) is on npm (unblocks r/selfhosted + defuses the #1 HN attack) | — | — |
| Week 1 | Awesome-LLMOps PR, console.dev pitch, AlternativeTo listing (once aged), MLOps Slack #be-shameless, Anthropic Discord showcase | Listings | One factual line each |
| Week 2 | **Show HN** (Tue–Thu 14:00–15:00 UTC, repo link, first comment within a minute, 3 hours of replies) | HN | Mechanism-led, weaknesses volunteered, what a fresh install does before any number |
| Week 2+1 day | r/LLMDevs writeup (the first Reddit post) | Reddit | Method before numbers; every figure with what was switched on |
| +1 day each | r/mlops (Self-Promotion flair) → r/ChatGPTCoding weekly thread | Reddit | Per-sub registers in reddit-posts.md |
| Week 3 | DevHunt listing; X thread (no hashtags, story form) | — | Incident language |
| Optional, after the above | r/ClaudeAI Showcase, as the cache-billing teaching post for people calling the API | Reddit | Teach first; say plainly that Claude Code users should expect little from a fresh install |
| Held | r/ClaudeCode: not a launch venue. Use the corrected draft only in a thread where people are building their own agents on the API | Reddit | — |
| Later | Product Hunt (Tue/Wed 12:01am PT, needs assets + some social proof); newsletter pitches once the mechanism post exists | — | — |
| Ongoing | Comment playbook in cost threads (r/AI_Agents, r/OpenAI, HN): answer fully, disclose, offer the do-it-by-hand path. These are the agent builders the product is for | — | "Full disclosure, I built…" |

## The language — one paragraph per audience

- **HN:** verifiable mechanism, modest numbers, concede fast. Benefit-percentage
  titles score 1–5 points in our niche; mechanism titles score 100–340. Never
  say "open source" (we're BUSL; one-sentence answer, never argued). Say what
  a fresh install does before the first figure.
- **r/LLMDevs / r/mlops:** method before numbers, tradeoffs stated, quality
  deltas disclosed. Their live anxiety — "prove quality didn't drop" — is
  literally our product; lead with verification, price last.
- **Reddit (Claude subs), if used at all:** humbled-builder first person,
  aimed at people building agents on the API, with "if you only use Claude
  Code, expect little from a fresh install" near the top. The winning title
  in this exact genre was "…and the results were humbling." Dollar
  confessions beat benefit claims. The install one-liner and `mesh proxy` in
  the first lines, paired with "or read the source first" (the LiteLLM
  supply-chain compromise is fresh memory — a proxy touching keys gets
  security-vetted in five comments).
- **Everywhere:** mirror the users' incident vocabulary (surprise bill,
  runaway, burned through, where the leak is, nothing paged, prove it) and
  never vendor vocabulary (optimize TCO, slash costs, supercharge). Write
  final drafts BY HAND — multiple communities now detect and punish
  machine-flavoured copy. Publish the losing cases inside the post; auditing
  inflated savings claims is these communities' favourite sport, so hand them
  the audit pre-done.

## Standing rules

- Founder fires every post, comment, PR and pitch. Agents draft and measure.
- Never ask anyone to upvote, anywhere. One venue per day. Nothing twice
  about the same tool within ~30 days — the acceptable sequel is a NEW
  measurement ("one month of ledger data: here's where it lost").
- Every post teaches the one path: install
  (`curl -fsSL https://www.mesh-technology.com/install.sh | sh`, or
  `npm install -g @harrym1707/mesh`), then `mesh proxy` (your own app or
  agent, with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
  `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`) or `mesh start` (Claude Code),
  then `mesh verify`. `npx -y -p @harrym1707/sdk mesh-proxy` is the
  no-install alternative only.
- Every post says what a fresh install does: three changes that do not alter
  the provider's answer (compact tool schemas, remove exact duplicate
  context, keep the cacheable prefix stable), and nothing else. The cache
  stamp and anything that can change an answer are opt-in; the post says how
  they are switched on today and promises nothing about tomorrow.
- Every figure comes from docs/NUMBERS.md with its label (LIVE or
  SIMULATOR), and the same sentence says "out of the box" or names the
  levers that were switched on. No out-of-the-box percentage is in
  docs/NUMBERS.md, so none is stated, estimated or implied. The line that
  is allowed: the three out-of-the-box changes account for under half of
  the LIVE figure of 2026-10-26, which also had the cache stamp and a
  tool-result cap switched on.
- Mesh is not sold as a token compressor, and no post promises a smaller
  bill. Nobody has measured Mesh against a real provider bill. Lead with
  keeping prompts cacheable and with the ledger the reader can recompute.
- Mesh has not run on anyone's traffic but our own test runs: no customers,
  no testimonials, no case studies, and no post may imply one.
- The product is written "Mesh" in anything posted or sent; `mesh` is the
  command.
- No version number in text meant to be posted. Both install routes gave
  0.2.5 when run on 2026-11-23 (website: build `59363e8`; npm: build
  `932bcd0`); the two are published separately and npm has lagged the website
  before, so check `mesh version` on both the morning of each post.
- Billing stays out of every title. Where a post or a reply gets to price, it
  links the Pricing and billing page
  (https://www.mesh-technology.com/pricing.html) and gives the fee as the
  Terms give it: no fee is due unless billing has been agreed in writing;
  where it has, the fee is 1% of verified savings for the month, rounded
  down to the cent, and nothing else. Nothing is charged automatically; a
  month is recomputed with `mesh statement --period YYYY-MM`; the statement
  is signed by the customer's own install, and the customer registers the key
  fingerprint once (`mesh statement --key`).
- Say how a saving is measured the same way every time: the usage after
  reduction is the provider's reported number; the baseline it is compared
  with is computed by Mesh.
- Retype every draft in your own words before it goes out.
- GitHub issues are the destination and the only contact route
  (https://github.com/Harrym1707/Mesh/issues/new; the pilot-quote template is
  there for anyone bringing an export). The repo is the landing page;
  mesh-technology.com is the reference, linked mid-body, never the headline
  link (young domain + HN's sign-up-page rule).
