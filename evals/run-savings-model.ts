import {
  WORKLOAD_ARCHETYPES,
  leversFor,
  minimumCacheableTokensFor,
  projectSavings,
  publishedModelPrices,
  lookupPrice,
  type SavingsProjection,
} from "../packages/core/src/index.js";

/**
 * Projects achievable cost reduction per workload archetype, at published rates.
 *
 * These are projections built from other people's published reduction factors,
 * held at or below the conservative end of what each reports. They are a
 * hypothesis to verify by replay on real traffic, not a measured result.
 */

const MODELS = [
  { provider: "anthropic", model: "Sonnet 5.5" },
  { provider: "openai", model: "gpt-5" },
] as const;

const AT = "2026-10-08";

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function summarise(projection: SavingsProjection): string {
  return [
    `${projection.workload.padEnd(34)}`,
    `baseline ${usd(projection.baselineCostUsd).padStart(10)}`,
    `after ${usd(projection.projectedCostUsd).padStart(9)}`,
    `saving ${pct(projection.savingPercent).padStart(7)}`,
    `(free ${pct(projection.deterministicSavingPercent).padStart(6)}`,
    `/ verify ${pct(projection.needsVerificationSavingPercent).padStart(6)})`,
  ].join("  ");
}

for (const { provider, model } of MODELS) {
  const lookup = lookupPrice(publishedModelPrices, { provider, model, at: AT });
  if (lookup.status === "unpriced") {
    console.log(`${provider}/${model}: ${lookup.reason}`);
    continue;
  }
  console.log(`\n=== ${provider}/${model} (input $${lookup.price.inputPerMillion}/M, ` +
    `cached $${lookup.price.cachedInputPerMillion ?? "n/a"}/M, output $${lookup.price.outputPerMillion}/M) ===`);
  for (const profile of Object.values(WORKLOAD_ARCHETYPES)) {
    const projection = projectSavings(profile, leversFor(profile), lookup.price, {
      minimumCacheableTokens: minimumCacheableTokensFor(provider, model),
    });
    console.log(summarise(projection));
    for (const warning of projection.warnings) console.log(`${" ".repeat(36)}note: ${warning}`);
  }
}

// Per-lever breakdown for the archetype with the most headroom.
const agent = WORKLOAD_ARCHETYPES.toolHeavyAgent!;
const agentPrice = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: AT });
if (agentPrice.status === "priced") {
  const projection = projectSavings(agent, leversFor(agent), agentPrice.price);
  console.log(`\n=== Lever breakdown: ${agent.name} on gpt-5, ${agent.requests} requests ===`);
  console.log(`${"lever".padEnd(28)} ${"risk".padEnd(20)} ${"removed".padStart(10)} ${"share".padStart(8)}`);
  for (const contribution of projection.contributions) {
    console.log(
      `${contribution.lever.padEnd(28)} ${contribution.risk.padEnd(20)} ` +
      `${usd(contribution.costRemovedUsd).padStart(10)} ${pct(contribution.sharePercent).padStart(8)}`,
    );
  }
  console.log(`${"TOTAL".padEnd(28)} ${"".padEnd(20)} ${usd(projection.savingUsd).padStart(10)} ` +
    `${pct(projection.savingPercent).padStart(8)}`);
  console.log(`\nInput tokens ${projection.inputTokensBefore.toLocaleString()} -> ` +
    `${Math.round(projection.inputTokensAfter).toLocaleString()}, of which ` +
    `${Math.round(projection.cachedInputTokens).toLocaleString()} served from cache.`);
  console.log(`Output tokens ${projection.outputTokensBefore.toLocaleString()} -> ` +
    `${Math.round(projection.outputTokensAfter).toLocaleString()}.`);
}
