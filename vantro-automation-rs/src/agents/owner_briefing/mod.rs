#[cfg(feature = "server")]
pub mod core_owner_briefing;

#[cfg(feature = "server")]
pub use core_owner_briefing::{
    generate_owner_briefing, EvidenceItem, OwnerBriefingAction, OwnerBriefingInput,
    OwnerBriefingOutput, OwnerBriefingSection,
};
