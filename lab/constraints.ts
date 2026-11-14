// The lab's non-negotiable constraints, encoded as checkable rules.
//
// These are the invariants from the mission brief and from Mesh's honesty
// doctrine (docs/strategy, docs/rnd/rnd-doctrine.md). They are applied by the
// Research agent (early rejection) and re-checked by the Maintainer (final
// gate). They cannot be overridden by any lead's own claims.

import type {
  BlindFeatureKind,
  ControlSurface,
  OptimisationLead,
} from "./types.js";

/** Strict by default: max permitted quality degradation is 2%. */
export const DEFAULT_MAX_QUALITY_DEGRADATION = 0.02;

/** A saving below this is not worth the lab's effort / risk. */
export const DEFAULT_MINIMUM_MEANINGFUL_SAVING_PERCENT = 3;

/** Blind feature inputs the lab is permitted to read. */
export const ALLOWED_FEATURE_INPUTS: readonly BlindFeatureKind[] = [
  "keyed-prefix-hash",
  "structural-counts",
  "token-counts",
  "aggregated-telemetry",
  "optimisation-ledger",
  "inter-arrival-timing",
  "model-id",
  "route-id",
];

/** Mesh-side control surfaces the lab may act on. */
export const ALLOWED_CONTROL_SURFACES: readonly ControlSurface[] = [
  "context-compaction",
  "deduplication",
  "cache-placement",
  "model-tier-routing",
  "output-caps",
  "other-proxy-side",
];

export type ConstraintCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

/**
 * Content-blind, always. An experiment must declare only allowed blind-feature
 * inputs and must not declare any forbidden (raw-content) input.
 */
export function checkContentBlind(lead: OptimisationLead): ConstraintCheck {
  const forbidden = lead.declaredForbiddenInputs ?? [];
  if (forbidden.length > 0) {
    return {
      name: "content-blind",
      passed: false,
      detail: `Declares forbidden raw-content inputs: ${forbidden.join(", ")}.`,
    };
  }
  const unknown = lead.featureInputs.filter(
    (input) => !ALLOWED_FEATURE_INPUTS.includes(input),
  );
  if (unknown.length > 0) {
    return {
      name: "content-blind",
      passed: false,
      detail: `Uses inputs outside the blind-feature allowlist: ${unknown.join(", ")}.`,
    };
  }
  if (lead.featureInputs.length === 0) {
    return {
      name: "content-blind",
      passed: false,
      detail: "Declares no inputs; an experiment must name the blind features it reads.",
    };
  }
  return {
    name: "content-blind",
    passed: true,
    detail: `Reads only blind features: ${lead.featureInputs.join(", ")}.`,
  };
}

/** Mesh-side optimisation only — must act on an approved control surface. */
export function checkMeshSideOnly(lead: OptimisationLead): ConstraintCheck {
  const ok = ALLOWED_CONTROL_SURFACES.includes(lead.controlSurface);
  return {
    name: "mesh-side-only",
    passed: ok,
    detail: ok
      ? `Acts on the ${lead.controlSurface} control surface.`
      : `Control surface ${lead.controlSurface} is not an approved Mesh optimisation surface.`,
  };
}

/** Must not rewrite or restructure the customer's application. */
export function checkAvoidsCustomerAppChanges(lead: OptimisationLead): ConstraintCheck {
  return {
    name: "no-customer-app-changes",
    passed: !lead.changesCustomerApplication,
    detail: lead.changesCustomerApplication
      ? "Would require changing the customer's own application — out of scope."
      : "Operates entirely in Mesh's proxy-side optimisation layer.",
  };
}

/**
 * Objectively testable — there must be a runnable implementation or an explicit
 * measurement path, otherwise it cannot be gated.
 */
export function checkObjectivelyTestable(lead: OptimisationLead): ConstraintCheck {
  const hasImpl = Boolean(lead.techniqueId) && Boolean(lead.datasetFixtureId);
  return {
    name: "objectively-testable",
    passed: hasImpl,
    detail: hasImpl
      ? `Has a runnable technique (${lead.techniqueId}) and a fixture (${lead.datasetFixtureId}).`
      : "No runnable implementation + fixture yet; cannot be objectively measured.",
  };
}

/** Meaningful saving — a tiny projected reduction is not worth the risk. */
export function checkMeaningfulSaving(
  lead: OptimisationLead,
  minimumPercent = DEFAULT_MINIMUM_MEANINGFUL_SAVING_PERCENT,
): ConstraintCheck {
  const ok = lead.expectedTokenReductionPercent >= minimumPercent;
  return {
    name: "meaningful-saving",
    passed: ok,
    detail: ok
      ? `Projected ${lead.expectedTokenReductionPercent}% ≥ ${minimumPercent}% threshold.`
      : `Projected ${lead.expectedTokenReductionPercent}% is below the ${minimumPercent}% threshold.`,
  };
}

/**
 * Acceptable risk. A lossless deduplication/compaction technique that reads
 * only blind features carries low privacy/reliability risk. Anything that both
 * touches output and is not objectively testable is flagged.
 */
export function checkAcceptableRisk(lead: OptimisationLead): ConstraintCheck {
  const touchesOutput = lead.controlSurface === "output-caps";
  const testable = Boolean(lead.techniqueId) && Boolean(lead.datasetFixtureId);
  const risky = touchesOutput && !testable;
  return {
    name: "acceptable-risk",
    passed: !risky,
    detail: risky
      ? "Touches output spend without a measurement path — unacceptable quality risk until gated."
      : "Risk is bounded: reversible, gated, and measured before any promotion.",
  };
}
