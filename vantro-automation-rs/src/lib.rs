// FILE: vantro-automation-rs/src/lib.rs
// Pure-Rust library entry point.
// Modules here have ZERO C dependencies — testable on Windows, Linux, CI without toolchain.
// The server binary (main.rs) adds axum/sqlx/tokio behind the `server` feature flag.

pub mod cache;
pub mod cashops;
pub mod cortex;
pub mod events;
pub mod harness;
