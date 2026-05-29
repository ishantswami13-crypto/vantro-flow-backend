// FILE: vantro-automation-rs/src/cashops/timing_engine.rs
// Timing signals — when to send, who should contact, what patterns to exploit.

use chrono::{Datelike, Timelike, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct TimingInput {
    pub best_reply_hour_of_day: Option<u8>,    // observed 0-23
    pub best_payment_day_of_month: Option<u8>, // observed 1-31
    pub staff_vs_owner_response: OwnerRequired,
    pub month_end_payer: bool,
    pub silence_days: u32,
    pub last_successful_followup_day_of_week: Option<u8>, // 0=Mon
    pub last_successful_followup_hour: Option<u8>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum OwnerRequired {
    StaffSufficient,
    OwnerPreferred,
    OwnerRequired,
}

#[derive(Debug, Serialize)]
pub struct TimingResult {
    pub best_day_of_week: Option<String>,
    pub best_hour_window: String,
    pub who_should_contact: OwnerRequired,
    pub rationale: String,
    pub send_now_ok: bool,
}

pub fn recommend(input: &TimingInput, now_utc: chrono::DateTime<chrono::Utc>) -> TimingResult {
    // Best hour window
    let best_hour = input
        .last_successful_followup_hour
        .or(input.best_reply_hour_of_day)
        .unwrap_or(10);
    let hour_window = format!("{:02}:00–{:02}:00 IST", best_hour, (best_hour + 2).min(20));

    // Best day
    let best_day_name = input.last_successful_followup_day_of_week.map(|d| {
        match d {
            0 => "Monday",
            1 => "Tuesday",
            2 => "Wednesday",
            3 => "Thursday",
            4 => "Friday",
            5 => "Saturday",
            _ => "Monday",
        }
        .to_string()
    });

    // Month-end guidance
    if input.month_end_payer {
        let dom = now_utc.day();
        let rationale = if dom >= 25 {
            "Month-end payer — send now, payment window is open".to_string()
        } else {
            format!(
                "Month-end payer — optimal to contact after day 25 (current: day {})",
                dom
            )
        };
        let send_now = dom >= 25;
        return TimingResult {
            best_day_of_week: best_day_name,
            best_hour_window: hour_window.clone(),
            who_should_contact: input.staff_vs_owner_response.clone(),
            rationale,
            send_now_ok: send_now,
        };
    }

    // Current time check (IST = UTC+5:30)
    let ist_hour = ((now_utc.hour() as i32 + 5) % 24 + 1).max(0) as u8; // approximate IST
    let is_good_hour = ist_hour >= 9 && ist_hour <= 19;
    let is_weekday = !matches!(now_utc.weekday(), Weekday::Sun);
    let send_now = is_good_hour && is_weekday;

    TimingResult {
        best_day_of_week: best_day_name,
        best_hour_window: hour_window.clone(),
        who_should_contact: input.staff_vs_owner_response.clone(),
        rationale: format!(
            "Best window: {} IST on business days. Current IST ~{:02}:00 — send {}.",
            hour_window,
            ist_hour,
            if send_now { "now" } else { "later today" }
        ),
        send_now_ok: send_now,
    }
}
