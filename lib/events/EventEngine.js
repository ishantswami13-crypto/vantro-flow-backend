// FILE: lib/events/EventEngine.js
const { safeLog } = require('../observability/logger');

class EventEngine {
  constructor() {
    this.handlers = new Map();
  }

  /**
   * Registers a handler for a specific event type.
   */
  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  /**
   * Emits a business event. Handlers are executed asynchronously 
   * so they don't block the main request loop.
   */
  emitBusinessEvent(userId, businessId, eventType, payload) {
    const handlers = this.handlers.get(eventType) || [];
    
    // Log the event explicitly
    safeLog('info', `[BUSINESS_EVENT] Emitted: ${eventType}`, {
      userId,
      businessId,
      eventType
    });

    // Fire and forget, catching errors so they don't crash the server
    setTimeout(() => {
      for (const handler of handlers) {
        Promise.resolve(handler({ userId, businessId, eventType, payload }))
          .catch(err => {
            safeLog('error', `[BUSINESS_EVENT] Handler failed for ${eventType}`, {
              error: err.message,
              userId,
              businessId
            });
          });
      }
    }, 0);
  }
}

const eventEngine = new EventEngine();

module.exports = {
  eventEngine,
  emitBusinessEvent: eventEngine.emitBusinessEvent.bind(eventEngine)
};
