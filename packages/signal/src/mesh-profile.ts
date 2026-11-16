/**
 * The canonical MESH brand profile — the one piece of this package that is
 * MESH-specific. Everything else takes a `BrandProfile`, so this is just a
 * convenient preset. Keep these facts consistent with the GEO entity strategy
 * (site /about + /product, GitHub, package registries): consistency is what
 * lets external systems describe the entity correctly.
 */

import type { BrandProfile } from "./schema.js";

export const MESH_BRAND_PROFILE: BrandProfile = {
  name: "MESH",
  aliases: ["mesh.ai", "@harrym1707/sdk", "MESH AI"],
  // Path-qualified on shared hosts: only MESH's own repo/packages are "owned",
  // not every github.com repo or every npm package.
  ownedDomains: ["mesh-ai.dev", "github.com/harrym1707", "npmjs.com/package/@harrym1707"],
  categories: [
    {
      id: "ai-cost-engineering",
      label: "AI cost engineering",
      keywords: ["ai cost engineering", "inference cost", "cost engineering"],
    },
    {
      id: "llm-cost-optimization",
      label: "LLM cost optimisation",
      keywords: ["llm cost", "cost optimization", "cost optimisation", "reduce llm cost"],
    },
    {
      id: "llm-routing",
      label: "LLM routing",
      // Bare "routing" is too generic (network routing, etc.); require the
      // qualified phrase so the association is specific to LLM/model routing.
      keywords: ["llm routing", "model routing", "route between models", "inference routing"],
    },
    {
      id: "token-optimization",
      label: "Token optimisation",
      keywords: ["token optimization", "token optimisation", "prompt tokens", "context optimization"],
    },
    {
      id: "semantic-caching",
      label: "Semantic caching",
      keywords: ["semantic caching", "semantic cache", "prompt caching"],
    },
    {
      id: "agent-cost-control",
      label: "Agent cost control",
      keywords: ["agent budget", "agent cost", "agentic cost", "tool call budget"],
    },
  ],
  canonicalClaims: [
    {
      id: "category",
      supportedBy: ["ai cost engineering", "inference optimisation", "inference optimization", "cost optimisation", "cost optimization"],
      contradictedBy: ["mesh network", "mesh wifi", "service mesh", "3d mesh", "polygon mesh"],
    },
    {
      id: "quality-safe",
      supportedBy: ["without compromising quality", "quality policy", "quality-safe", "preserves quality", "without sacrificing quality"],
    },
    {
      id: "mechanism",
      // Specific mechanism phrases only — bare "shadow" matched unrelated text.
      supportedBy: ["model routing", "semantic caching", "context optimisation", "context optimization", "shadow testing", "shadow traffic", "progressive rollout", "automatic rollback"],
    },
  ],
  competitors: ["OpenRouter", "LiteLLM", "Helicone", "Portkey", "Martian", "Not Diamond", "Unify"],
};
