// FILE: lib/access/validation.js
// Strict, pure validation for the public access application. Returns every
// field error at once (so the form can show them together) and a normalized
// value object; never trusts client-side validation.

const { listManifests } = require('../connectors/registry');

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

function validateApplication(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const selectable = new Set(listManifests().filter((m) => m.authType !== 'public_feed').map((m) => m.id));

  const need = (field, value, min, max, label) => {
    if (value.length < min) errors[field] = min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`;
    else if (value.length > max) errors[field] = `${label} must be at most ${max} characters`;
  };
  const optional = (field, value, max, label) => {
    if (value.length > max) errors[field] = `${label} must be at most ${max} characters`;
  };

  const value = {
    name: str(b.name),
    email: str(b.email).toLowerCase(),
    company: str(b.company),
    website: str(b.website),
    role: str(b.role),
    companySize: str(b.companySize),
    industry: str(b.industry),
    country: str(b.country).toUpperCase(),
    systems: Array.isArray(b.systems) ? [...new Set(b.systems.filter((s) => typeof s === 'string'))] : [],
    otherSystems: str(b.otherSystems),
    problem: str(b.problem),
    desiredOutcome: str(b.desiredOutcome),
    willConnectSystems: b.willConnectSystems,
    notes: str(b.notes),
  };

  need('name', value.name, 2, 120, 'Name');
  if (!EMAIL_RE.test(value.email) || value.email.length > 254) errors.email = 'Enter a valid work email';
  need('company', value.company, 2, 160, 'Company');
  if (value.website) {
    const candidate = /^https?:\/\//i.test(value.website) ? value.website : `https://${value.website}`;
    try {
      const u = new URL(candidate);
      if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || candidate.length > 200) throw new Error('bad');
      value.website = u.origin + (u.pathname === '/' ? '' : u.pathname);
    } catch { errors.website = 'Enter a valid website, e.g. example.com'; }
  }
  need('role', value.role, 2, 100, 'Role');
  if (!COMPANY_SIZES.includes(value.companySize)) errors.companySize = 'Choose a company size';
  need('industry', value.industry, 2, 100, 'Industry');
  if (!/^[A-Z]{2}$/.test(value.country)) errors.country = 'Choose a country';
  if (value.systems.length > 20 || value.systems.some((s) => !selectable.has(s))) errors.systems = 'Choose systems from the list';
  if (value.systems.length === 0 && !value.otherSystems) errors.systems = 'Tell us at least one system your company uses';
  optional('otherSystems', value.otherSystems, 500, 'Other systems');
  need('problem', value.problem, 20, 2000, 'This answer');
  need('desiredOutcome', value.desiredOutcome, 10, 1000, 'This answer');
  if (typeof value.willConnectSystems !== 'boolean') errors.willConnectSystems = 'Choose yes or no';
  optional('notes', value.notes, 2000, 'Notes');

  return { ok: Object.keys(errors).length === 0, errors, value };
}

module.exports = { validateApplication, COMPANY_SIZES };
