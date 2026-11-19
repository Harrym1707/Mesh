# Communities — where MESH launches, in what order, in whose language

**Draft plan; nothing here has been posted.** Refreshed 2026-11-18 for MESH
0.2.3.

The one-page view. Research: research/hackernews.md, research/reddit.md,
research/channels.md. Posts: show-hn.md, reddit-posts.md, other-channels.md.

## The sequence

| Week | Action | Venue | Register to write in |
|---|---|---|---|
| Now | Create AlternativeTo account (must age 7 days); start commenting (no links) in r/ClaudeCode, r/LLMDevs, r/AI_Agents; post occasionally from the HN account if it's fresh | — | Helpful engineer, zero promo |
| Done | The MIT-verifier split: `@harrym1707/verify` (MIT) is on npm (unblocks r/selfhosted + defuses the #1 HN attack) | — | — |
| Week 1 | Awesome-LLMOps PR, console.dev pitch, AlternativeTo listing (once aged), MLOps Slack #be-shameless, Anthropic Discord showcase | Listings | One factual line each |
| Week 2 | **Show HN** (Tue–Thu 14:00–15:00 UTC, repo link, first comment within a minute, 3 hours of replies) | HN | Mechanism-led, weaknesses volunteered, modest checkable numbers |
| Week 2+1 day | r/ClaudeCode text post | Reddit | Humbled builder: pain → one-command install, no signup → the ledger that caught our own lever losing |
| +1 day each | r/ClaudeAI Showcase → r/LLMDevs writeup → r/mlops (Self-Promotion flair) → r/ChatGPTCoding weekly thread | Reddit | Per-sub registers in reddit-posts.md |
| Week 3 | DevHunt listing; X thread (no hashtags, story form) | — | Incident language |
| Later | Product Hunt (Tue/Wed 12:01am PT, needs assets + some social proof); newsletter pitches once the mechanism post exists | — | — |
| Ongoing | Comment playbook in cost threads (r/AI_Agents, r/OpenAI, HN): answer fully, disclose, offer the do-it-by-hand path | — | "Full disclosure, I built…" |

## The language — one paragraph per audience

- **HN:** verifiable mechanism, modest numbers, concede fast. Benefit-percentage
  titles score 1–5 points in our niche; mechanism titles score 100–340. Never
  say "open source" (we're BUSL; one-sentence answer, never argued).
- **Reddit (Claude subs):** humbled-builder first person. The winning title in
  this exact genre was "…and the results were humbling." Dollar confessions
  beat benefit claims. The install one-liner and `mesh start` in the first
  three lines, paired with "or read the source first" (the LiteLLM
  supply-chain compromise is fresh memory — a proxy touching keys gets
  security-vetted in five comments).
- **r/LLMDevs / r/mlops:** method before numbers, tradeoffs stated, quality
  deltas disclosed. Their live anxiety — "prove quality didn't drop" — is
  literally our product; lead with verification, price last.
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
  `npm install -g @harrym1707/mesh`), then `mesh start` (Claude Code) or
  `mesh proxy` (your own app, with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`
  or `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`), then `mesh verify`.
  `npx -y -p @harrym1707/sdk mesh-proxy` is the no-install alternative only.
- Every savings number comes from docs/NUMBERS.md with its label (LIVE or
  SIMULATOR). MESH has not run on anyone's traffic but our own test runs:
  no customers, no testimonials, no case studies, and no post may imply one.
- GitHub issues are the destination and the only contact route
  (https://github.com/Harrym1707/Mesh/issues/new; the pilot-quote template is
  there for anyone bringing an export). The repo is the landing page;
  mesh-technology.com is the reference, linked mid-body, never the headline
  link (young domain + HN's sign-up-page rule).
