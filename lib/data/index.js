'use strict';
// lib/data — Starlane's data access layer.
//
//   withTenant / readTenant   tenant-scoped transactions (app.user_id, timeout)
//   defineRepository          table access that always filters by tenant
//   getCache / createCache    L1 cache, memory or shared Postgres backend
//
// New code reaches the database through here. Existing routes keep working on
// their current paths and move over one area at a time. See
// docs/architecture/data-layers.md.

const { withTenant, readTenant, assertTenantId } = require('./tenantDb');
const { defineRepository } = require('./repository');
const { getCache, createCache } = require('./cache');

module.exports = { withTenant, readTenant, assertTenantId, defineRepository, getCache, createCache };
