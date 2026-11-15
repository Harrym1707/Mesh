# Comparison rebuild — primary-source fact sheets (2026-10-22)

Field reports from the competitor researchers; every fact cites a vendor
primary source with access date. These are the ONLY permitted inputs for
docs/site/comparison.md claims. Key corrections to the old page:

- LiteLLM NOW HAS one-flag automatic Anthropic cache placement
  (enable_anthropic_prompt_caching, 5m default/1h option) and MCP tool-schema
  deferral (native token reduction) — any claim that LiteLLM "only tracks,
  never reduces" is outdated and must not ship. Prompt compression is a
  third-party Headroom sidecar, not LiteLLM core. Enterprise pricing has no
  public number. MIT core.
- Helicone's gateway response caching DOES save real provider money on
  byte-identical repeats (never say "latency only"); it does not reduce
  tokens on novel requests and the customer writes their own cache_control
  for Anthropic. Apache-2.0 main repo; Pro $79/mo, Team $799/mo.
- Langfuse is async observability (never in the request path, reduces
  nothing, claims nothing else); its cost tracking is best-in-class
  auditable (daily automated price audits, customer-overridable prices,
  exact-cost ingestion) — credit it. MIT except ee/. Cloud Core $29 / Pro
  $199 / Enterprise $2,499; unlimited MIT self-host. v4 shipped 2026.
- MESH's surviving differentiators: per-request LOSSLESS token reduction +
  verified, customer-recomputable savings ledger + do-not-pay-us verdict +
  loss accounting (negatives bill against MESH) + volatility guard. State
  LiteLLM's cache flag generously, then the difference: placement without
  measurement can lose money silently (our own live export proved it) —
  MESH meters the net, including when the answer is "don't pay us".
- UNVERIFIED (do not publish): Helicone per-request overage rates, Helicone
  gateway GA date, ai-gateway repo licence, Headroom ownership/pricing.
