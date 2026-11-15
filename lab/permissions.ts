// Permission boundaries for the lab's agents.
//
// No agent has unrestricted access. Each role holds a narrow set of
// capabilities; the ledger refuses any mutation the acting role is not entitled
// to make. This is what structurally enforces the two load-bearing separations
// from the mission brief:
//   - the Builder may never promote its own work;
//   - the Builder and the Evaluator are logically separate (different roles,
//     different capabilities), so a builder can never declare its own
//     experiment successful.

export type AgentRole =
  | "scout"
  | "research"
  | "design"
  | "builder"
  | "red-team"
  | "evaluation"
  | "maintainer"
  | "orchestrator";

export type Capability =
  | "lead:create"
  | "record:read"
  | "record:research"
  | "record:design"
  | "record:build"
  | "record:red-team"
  | "record:evaluate"
  | "record:promote"
  | "portfolio:write";

const MATRIX: Record<AgentRole, readonly Capability[]> = {
  scout: ["lead:create", "record:read"],
  research: ["record:read", "record:research"],
  design: ["record:read", "record:design"],
  builder: ["record:read", "record:build"],
  "red-team": ["record:read", "record:red-team"],
  evaluation: ["record:read", "record:evaluate"],
  maintainer: ["record:read", "record:promote", "portfolio:write"],
  orchestrator: ["record:read"],
};

export function can(role: AgentRole, capability: Capability): boolean {
  return MATRIX[role]?.includes(capability) ?? false;
}

export class PermissionError extends Error {
  constructor(
    readonly role: AgentRole,
    readonly capability: Capability,
  ) {
    super(`Role "${role}" is not permitted to "${capability}".`);
    this.name = "PermissionError";
  }
}

export function assertCan(role: AgentRole, capability: Capability): void {
  if (!can(role, capability)) throw new PermissionError(role, capability);
}

/** The capability required to transition a record out of each status. */
export function capabilityForStatus(status: string): Capability | null {
  switch (status) {
    case "discovered":
      return "record:research";
    case "designed":
      return "record:design";
    case "building":
      return "record:build";
    case "red_team":
      return "record:red-team";
    case "evaluating":
      return "record:evaluate";
    case "maintaining":
      return "record:promote";
    default:
      return null;
  }
}
