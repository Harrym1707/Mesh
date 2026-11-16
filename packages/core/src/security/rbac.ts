/**
 * Role-based access control, and the tenant-scoping boundary from
 * `02_TECHNICAL_ARCHITECTURE.md` §10 ("Every request is tenant-scoped. Enforce
 * tenant_id, application_id, policy_id at every persistence boundary").
 *
 * This module is the AUTHORIZATION half of enterprise access control. The
 * AUTHENTICATION half — proving who the subject is — is SSO (an external IdP;
 * see the hardening plan, bucket B). This module takes an already-authenticated
 * `Subject` (whatever an IdP asserted, reduced to a tenant id and a set of role
 * assignments) and answers one question, purely and deny-by-default: may this
 * subject take this action on this resource?
 *
 * Two independent gates must both pass:
 *   1. Scope: the resource's tenant must match the subject's tenant, and an
 *      application-scoped assignment must match the resource's application.
 *      No assignment can ever authorize across tenants — it is not
 *      representable, which is the §10 "no cross-tenant" guarantee in types.
 *   2. Permission: some role the subject holds in the matching scope must grant
 *      the permission the action requires.
 */

/** Everything a subject can be allowed to do. Extend alongside `AuditAction`. */
export type Permission =
  | "policy.read"
  | "policy.write"
  | "policy.sign"
  | "rollout.read"
  | "rollout.write"
  | "rollout.rollback"
  | "audit.read"
  | "billing.read"
  | "member.read"
  | "member.manage"
  // Data-governance operations — the most dangerous acts in the system. Each
  // has a dedicated permission so it is authorizable (and auditable) in its own
  // right, never bundled under a coarser grant.
  | "data.export"
  | "data.purge"
  | "config.change";

/** The built-in roles. Each maps to a fixed permission set below. */
export type Role = "owner" | "admin" | "operator" | "analyst" | "viewer";

/**
 * Role → permissions. Deliberately explicit (no inheritance magic) so the
 * grant of every role is auditable by reading this one table.
 *
 * - viewer: read-only across the board.
 * - analyst: viewer + can read the audit log and billing (the compliance/
 *   finance reader) but changes nothing.
 * - operator: runs rollouts — read/write/rollback rollouts and read policies —
 *   but cannot author or sign policies or manage members.
 * - admin: the full permission set; authors and signs policies, manages
 *   members, reads audit and billing, and runs the data-governance ops
 *   (export/purge/config.change).
 * - owner: the same full set as admin today. Kept as a distinct role for
 *   tenant-level ownership semantics (e.g. the principal that cannot be removed
 *   by an admin); the distinction lives in member-management policy, not in an
 *   extra permission, so the two share one permission list.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["policy.read", "rollout.read", "member.read"],
  analyst: ["policy.read", "rollout.read", "member.read", "audit.read", "billing.read"],
  operator: ["policy.read", "rollout.read", "rollout.write", "rollout.rollback", "member.read"],
  admin: [
    "policy.read",
    "policy.write",
    "policy.sign",
    "rollout.read",
    "rollout.write",
    "rollout.rollback",
    "audit.read",
    "billing.read",
    "member.read",
    "member.manage",
    "data.export",
    "data.purge",
    "config.change",
  ],
  owner: [
    "policy.read",
    "policy.write",
    "policy.sign",
    "rollout.read",
    "rollout.write",
    "rollout.rollback",
    "audit.read",
    "billing.read",
    "member.read",
    "member.manage",
    "data.export",
    "data.purge",
    "config.change",
  ],
};

/**
 * Privilege ordering, highest first, used only to report WHICH role authorized
 * a decision when a subject holds several that would all grant it. It does not
 * affect whether access is allowed — only the `via` label.
 */
export const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  operator: 2,
  analyst: 1,
  viewer: 0,
};

/**
 * One role grant. `applicationId` absent means the role applies to the whole
 * tenant (every application). Present means it applies ONLY to that
 * application — an application-scoped operator cannot touch another app's
 * rollouts.
 */
export type RoleAssignment = {
  role: Role;
  /** Omit for a tenant-wide grant; set to scope the grant to one application. */
  applicationId?: string;
};

/** An authenticated principal, as reduced from an IdP assertion. */
export type Subject = {
  id: string;
  tenantId: string;
  assignments: readonly RoleAssignment[];
};

/** The thing being acted on. Its tenant is always required (§10). */
export type Resource = {
  tenantId: string;
  applicationId?: string;
  policyId?: string;
};

export type AuthorizationDecision =
  | { allowed: true; via: Role }
  | { allowed: false; reason: "cross_tenant" | "out_of_scope" | "missing_permission" };

/** Which permission an action requires. The single mapping callers must not bypass. */
const ACTION_PERMISSION: Record<string, Permission> = {
  "policy.publish": "policy.write",
  "policy.sign": "policy.sign",
  "policy.disable": "policy.write",
  "policy.read": "policy.read",
  "rollout.change": "rollout.write",
  "rollout.rollback": "rollout.rollback",
  "rollout.read": "rollout.read",
  "audit.read": "audit.read",
  "billing.read": "billing.read",
  "access.grant": "member.manage",
  "access.revoke": "member.manage",
  "member.read": "member.read",
  "data.export": "data.export",
  "data.purge": "data.purge",
  "config.change": "config.change",
};

/** True when a role holds the permission. */
export function roleGrants(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Does an assignment apply to this resource? A tenant-wide assignment applies
 * to every application in the (already tenant-matched) resource; an
 * application-scoped assignment applies only when the ids match.
 */
function assignmentCoversResource(assignment: RoleAssignment, resource: Resource): boolean {
  if (assignment.applicationId === undefined) return true;
  return assignment.applicationId === resource.applicationId;
}

/**
 * The authorization decision. Deny-by-default: every path that is not an
 * explicit allow returns `allowed: false` with a reason, so a caller can log
 * WHY access was refused into the audit log.
 *
 * Order matters: cross-tenant is checked first and is unconditional — no role,
 * not even owner, authorizes across tenants.
 */
export function authorize(subject: Subject, permission: Permission, resource: Resource): AuthorizationDecision {
  if (subject.tenantId !== resource.tenantId) {
    return { allowed: false, reason: "cross_tenant" };
  }
  const inScope = subject.assignments.filter((a) => assignmentCoversResource(a, resource));
  if (inScope.length === 0) {
    return { allowed: false, reason: "out_of_scope" };
  }
  // Report the HIGHEST-privilege role that grants the permission, not merely the
  // first one listed, so `via` is stable regardless of assignment order.
  const granting = inScope
    .filter((a) => roleGrants(a.role, permission))
    .sort((left, right) => ROLE_RANK[right.role] - ROLE_RANK[left.role])[0];
  if (granting === undefined) {
    return { allowed: false, reason: "missing_permission" };
  }
  return { allowed: true, via: granting.role };
}

/**
 * Authorize a named action, resolving the required permission from the shared
 * action→permission table. Use this at a boundary where you have an action
 * name (the same strings the audit log records); use `authorize` directly when
 * you already hold a permission. An unknown action is denied, never allowed.
 */
export function authorizeAction(subject: Subject, action: string, resource: Resource): AuthorizationDecision {
  const permission = ACTION_PERMISSION[action];
  if (permission === undefined) {
    return { allowed: false, reason: "missing_permission" };
  }
  return authorize(subject, permission, resource);
}
