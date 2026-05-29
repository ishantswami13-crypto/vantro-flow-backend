// FILE: vantro-automation-rs/src/auth.rs
// JWT extractor compatible with Node's jsonwebtoken signing.
// The Node backend signs JWTs with { userId, email, ... } claims using HS256.
// Dev mode: also accepts x-user-id header (harness / local testing only).

use axum::{
    async_trait,
    extract::{FromRequestParts, State},
    http::{request::Parts, HeaderMap},
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{error::AppError, AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub email: Option<String>,
    pub exp: Option<u64>,
    pub iat: Option<u64>,
}

/// Authenticated user extracted from the request.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub raw_id: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Dev / test mode: accept x-user-id bypass for harness tests.
        if state.config.is_dev() {
            if let Some(uid) = parts.headers.get("x-user-id").and_then(|v| v.to_str().ok()) {
                let user_id = Uuid::parse_str(uid)
                    .map_err(|_| AppError::BadRequest("Invalid x-user-id UUID".into()))?;
                return Ok(AuthUser {
                    user_id,
                    raw_id: uid.to_string(),
                });
            }
        }

        let token = extract_bearer(&parts.headers)
            .ok_or_else(|| AppError::Unauthorised("Missing Authorization header".into()))?;

        let claims = verify_jwt(token, &state.config.jwt_secret)?;

        // Support both UUID and non-UUID user IDs (legacy).
        let user_id = Uuid::parse_str(&claims.user_id)
            .map_err(|_| AppError::Unauthorised("Invalid userId in token".into()))?;

        Ok(AuthUser {
            user_id,
            raw_id: claims.user_id,
        })
    }
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get("authorization")?.to_str().ok()?;
    value.strip_prefix("Bearer ")
}

fn verify_jwt(token: &str, secret: &str) -> Result<JwtClaims, AppError> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    // Node doesn't always set exp; be lenient.
    validation.validate_exp = false;
    validation.required_spec_claims.clear();

    let data = decode::<JwtClaims>(token, &key, &validation)
        .map_err(|e| AppError::Unauthorised(format!("Invalid token: {}", e)))?;
    Ok(data.claims)
}
