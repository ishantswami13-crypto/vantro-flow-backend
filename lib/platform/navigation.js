'use strict';
// Server-built navigation. The sidebar renders exactly these groups, so what
// a person sees follows their organization's enabled applications and their
// role. Hiding a row is not the security boundary: every route behind it
// checks membership and permission on the server as well.

const { can } = require('./roles');
const { APPS } = require('./apps');

function buildNavigation({ role, enabledApps }) {
  const groups = [];
  groups.push({
    key: 'workspace',
    label: 'Workspace',
    items: [
      { key: 'ask', href: '/bridge', label: 'New question', icon: 'plus' },
      { key: 'agents', href: '/agents', label: 'Agents', icon: 'agents' },
      { key: 'knowledge', href: '/knowledge', label: 'Knowledge', icon: 'library' },
      { key: 'workflows', href: '/workflows', label: 'Workflows', icon: 'workflows' },
      { key: 'command', href: '/command', label: 'Command Center', icon: 'chart' },
    ],
  });

  const org = [
    { key: 'teams', href: '/organization?tab=teams', label: 'Teams', icon: 'spaces' },
    { key: 'connections', href: '/connections', label: 'Connections', icon: 'sources' },
  ];
  if (can(role, 'approvals.view')) org.push({ key: 'approvals', href: '/approvals', label: 'Approvals', icon: 'prepared' });
  org.push({ key: 'activity', href: '/activity', label: 'Activity', icon: 'history' });
  groups.push({ key: 'organization', label: 'Organization', items: org });

  const apps = APPS.filter((a) => a.status === 'available' && enabledApps.has(a.key));
  if (apps.length) {
    groups.push({
      key: 'applications',
      label: 'Applications',
      items: apps.map((a) => ({ key: `app.${a.key}`, href: a.items[0].href, label: a.name, icon: 'app', app: a.key, children: a.items })),
    });
  }

  if (can(role, 'org.manage')) {
    groups.push({
      key: 'administration',
      label: 'Administration',
      items: [
        { key: 'org-settings', href: '/organization', label: 'Organization settings', icon: 'settings' },
        { key: 'members', href: '/organization?tab=members', label: 'Members and roles', icon: 'members' },
        { key: 'policies', href: '/organization?tab=policies', label: 'Agent policies', icon: 'control' },
        { key: 'usage', href: '/organization?tab=usage', label: 'Usage and limits', icon: 'chart' },
        { key: 'audit', href: '/organization?tab=audit', label: 'Audit log', icon: 'history' },
      ],
    });
  }
  return groups;
}

module.exports = { buildNavigation };
