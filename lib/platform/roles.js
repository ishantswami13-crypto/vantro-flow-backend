'use strict';
// The organization role model. Roles are ordered; a permission names the
// lowest role that holds it. Resource-level checks (agent ownership, team
// membership, knowledge scope) are layered on top in each module.

const ROLES = ['viewer', 'member', 'admin', 'owner'];
const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

const PERMISSIONS = Object.freeze({
  'org.view': 'viewer',
  'executions.view': 'viewer',
  'agents.view': 'viewer',
  'knowledge.view': 'viewer',
  'approvals.view': 'member',
  'agents.create': 'member',
  'agents.run': 'member',
  'knowledge.write': 'member',
  'usage.view': 'admin',
  'org.manage': 'admin',
  'apps.manage': 'admin',
  'members.manage': 'admin',
  'teams.manage': 'admin',
  'policies.manage': 'admin',
  'audit.view': 'admin',
  'agents.manage_any': 'admin',
  'org.transfer': 'owner',
});

function atLeast(role, minimum) {
  return role in RANK && minimum in RANK && RANK[role] >= RANK[minimum];
}

function can(role, permission) {
  const min = PERMISSIONS[permission];
  if (!min) throw new Error(`Unknown permission ${permission}`);
  return atLeast(role, min);
}

function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => can(role, p));
}

module.exports = { ROLES, RANK, PERMISSIONS, can, atLeast, permissionsFor };
