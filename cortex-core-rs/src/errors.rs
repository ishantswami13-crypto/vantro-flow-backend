// FILE: cortex-core-rs/src/errors.rs

use std::fmt;

#[derive(Debug)]
pub enum CortexError {
    InvalidInput(String),
    Json(serde_json::Error),
}

impl fmt::Display for CortexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CortexError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
            CortexError::Json(e) => write!(f, "JSON error: {}", e),
        }
    }
}

impl From<serde_json::Error> for CortexError {
    fn from(e: serde_json::Error) -> Self {
        CortexError::Json(e)
    }
}
