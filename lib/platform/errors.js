'use strict';
// Errors the platform routes turn into HTTP responses. `code` is stable and
// safe to show; `message` is written for the person using Starlane.

class PlatformError extends Error {
  constructor(status, code, message, detail = undefined) {
    super(message);
    this.name = 'PlatformError';
    this.status = status;
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const badRequest = (message, detail) => new PlatformError(400, 'INVALID_REQUEST', message, detail);
const forbidden = (message = 'You do not have permission to do that in this organization.', code = 'FORBIDDEN') => new PlatformError(403, code, message);
const notFound = (what = 'That item') => new PlatformError(404, 'NOT_FOUND', `${what} was not found in this organization.`);
const conflict = (message, code = 'CONFLICT', detail) => new PlatformError(409, code, message, detail);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(id, what = 'id') {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw badRequest(`${what} must be a valid id`);
  return id;
}

module.exports = { PlatformError, badRequest, forbidden, notFound, conflict, assertUuid, UUID_RE };
