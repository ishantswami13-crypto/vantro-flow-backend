// FILE: vantro-automation-rs/src/events/publisher.rs
// NATS JetStream publisher stub. No async dependency in the lib target.

use crate::events::types::BusinessEvent;

pub struct EventPublisher {
    pub nats_configured: bool,
}

impl EventPublisher {
    pub fn new(nats_url: Option<&str>) -> Self {
        EventPublisher {
            nats_configured: nats_url.is_some(),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.nats_configured
    }

    /// Log business event. Phase 2: async_nats publish via `server` feature.
    pub fn publish_sync(&self, event: &BusinessEvent) {
        tracing::info!(
            event_type = ?event.event_type,
            user_id    = %event.user_id,
            entity_id  = ?event.entity_id,
            "[Events] Business event"
        );
    }
}
