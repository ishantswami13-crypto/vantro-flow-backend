'use strict';
// lib/data/events — L2 event log + transactional outbox + delivery.
const { appendEvent, readStream, recentEvents } = require('./log');
const { createDispatcher, cacheInvalidationConsumer } = require('./dispatcher');

module.exports = { appendEvent, readStream, recentEvents, createDispatcher, cacheInvalidationConsumer };
