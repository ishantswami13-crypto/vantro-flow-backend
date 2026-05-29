// FILE: vantro-automation-rs/src/cashops/tone_engine.rs
// Tone selection engine — never produces abusive/threatening language.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct ToneInput {
    pub days_overdue: u32,
    pub broken_promises: u32,
    pub relationship_years: f64,
    pub dispute_active: bool,
    pub customer_value_inr: f64,
    pub last_tone_used: Option<ToneType>,
    pub last_tone_succeeded: Option<bool>,
    pub owner_call_dependency: f64,
    pub polite_sensitivity: f64,
}

#[derive(Debug, Serialize, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToneType {
    Soft,
    Professional,
    Firm,
    Escalation,
    RelationshipPreserving,
    DisputeResolutionFirst,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Whatsapp,
    Call,
    Email,
}

#[derive(Debug, Serialize)]
pub struct ToneResult {
    pub tone: ToneType,
    pub channel: Channel,
    pub message_constraints: Vec<String>,
    pub rationale: String,
}

pub fn select(input: &ToneInput) -> ToneResult {
    // Hard safety constraints apply ALWAYS regardless of tone
    let constraints = vec![
        "No legal threats or FIR mentions".to_string(),
        "No harassment language".to_string(),
        "No promises the owner has not approved".to_string(),
        "No amount changes without owner approval".to_string(),
    ];

    if input.dispute_active {
        return ToneResult {
            tone: ToneType::DisputeResolutionFirst,
            channel: Channel::Call,
            message_constraints: constraints,
            rationale: "Active dispute — resolve before any payment ask".to_string(),
        };
    }

    // If previous polite tone succeeded, repeat it
    if input.last_tone_used == Some(ToneType::Soft) && input.last_tone_succeeded == Some(true) {
        return ToneResult {
            tone: ToneType::Soft,
            channel: Channel::Whatsapp,
            message_constraints: constraints,
            rationale: "Polite reminder worked last time — repeat".to_string(),
        };
    }

    // High-value long-term customers → relationship preserving even when late
    if input.customer_value_inr > 500_000.0
        && input.relationship_years > 2.0
        && input.days_overdue < 30
    {
        return ToneResult {
            tone: ToneType::RelationshipPreserving,
            channel: Channel::Call,
            message_constraints: constraints,
            rationale: "High-value long-term customer — protect relationship while collecting"
                .to_string(),
        };
    }

    let (tone, channel, rationale) = if input.days_overdue <= 7 && input.broken_promises == 0 {
        (
            ToneType::Soft,
            Channel::Whatsapp,
            "Early stage — polite approach sufficient".to_string(),
        )
    } else if input.days_overdue <= 21
        && input.broken_promises < 2
        && input.polite_sensitivity > 0.5
    {
        (
            ToneType::Professional,
            Channel::Whatsapp,
            "Mid-stage — professional tone maintains relationship".to_string(),
        )
    } else if input.broken_promises >= 2 || input.days_overdue > 21 {
        if input.owner_call_dependency > 0.5 {
            (
                ToneType::Firm,
                Channel::Call,
                "Owner call dependency detected — direct call needed".to_string(),
            )
        } else {
            (
                ToneType::Firm,
                Channel::Whatsapp,
                "Multiple broken promises or long overdue — firm approach".to_string(),
            )
        }
    } else {
        (
            ToneType::Escalation,
            Channel::Call,
            "Escalation required — owner involvement needed".to_string(),
        )
    };

    ToneResult {
        tone,
        channel,
        message_constraints: constraints,
        rationale,
    }
}
