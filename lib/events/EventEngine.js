// FILE: lib/events/EventEngine.js
// In-process pub/sub event bus for Vantro.
// NOTE: The authoritative business event persistence lives in:
//   lib/services/orchestrator/event.service.js (writes to business_events table)
// This class handles in-process listeners only (e.g. cache invalidation, reconciliation hooks).
const { safeLog } = require('../observability/logger');

class EventEngine {
  constructor() {
    this.handlers = new Map();
  }

  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  // Emit an in-process event. Handlers run asynchronously and never block the caller.
  // signature: (userId, businessId, eventType, payload) — businessId included for future multi-tenant support.
  emitBusinessEvent(userId, businessIdOrEventType, eventTypeOrPayload, payloadOrUndefined) {
    // Support both 3-arg (userId, eventType, payload) and 4-arg (userId, businessId, eventType, payload) calls
    let eventType, payload;
    if (payloadOrUndefined !== undefined) {
      // 4-arg form: userId, businessId, eventType, payload
      eventType = eventTypeOrPayload;
      payload   = payloadOrUndefined;
    } else {
      // 3-arg form: userId, eventType, payload
      eventType = businessIdOrEventType;
      payload   = eventTypeOrPayload || {};
    }

    const handlers = this.handlers.get(eventType) || [];

    safeLog('info', `[EventEngine] Emitted: ${eventType}`, { userId, eventType });

    setTimeout(() => {
      for (const handler of handlers) {
        Promise.resolve(handler({ userId, eventType, payload }))
          .catch(err => {
            safeLog('error', `[EventEngine] Handler failed for ${eventType}`, {
              error: err.message,
              userId,
            });
          });
      }
    }, 0);
  }
}

const eventEngine = new EventEngine();

module.exports = {
  eventEngine,
  emitBusinessEvent: eventEngine.emitBusinessEvent.bind(eventEngine),
};
