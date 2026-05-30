// FILE: vantro-automation-rs/src/auth.rs
// JWT extractor compatible with Node's jsonwebtoken signing.
// The Node backend signs JWTs with { userId, email, ... } claims using HS256.
// Dev mode: also accepts x-user-id header (harness / local testing only).

use axum::{
    async_trait,
    extract::FromRequestParts,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    // skip_serializing_if so an absent exp serialises as a MISSING field, not
    // `"exp": null`. Real Node tokens omit exp when not set; matching that keeps
    // jsonwebtoken's optional-exp validation well-defined (see verify_jwt).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    // Validate `exp` WHEN it is present (reject expired tokens), but do not
    // REQUIRE it: Node does not always set exp. Clearing required_spec_claims
    // makes exp optional; validate_exp = true makes a *present* exp enforced.
    // Net effect: tokens with a past exp are rejected; tokens without exp pass.
    validation.validate_exp = true;
    validation.required_spec_claims.clear();

    // NOTE on log safety: the error `e` from jsonwebtoken is a variant like
    // InvalidSignature / ExpiredSignature / InvalidToken and never contains the
    // raw token string, so formatting it here cannot leak the token. This is
    // asserted by `token_value_never_appears_in_error` in the tests below.
    let data = decode::<JwtClaims>(token, &key, &validation)
        .map_err(|e| AppError::Unauthorised(format!("Invalid token: {}", e)))?;
    Ok(data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    const SECRET: &str = "test-secret-please-ignore-0123456789abcdef";

    fn make_token(user_id: &str, exp: Option<u64>) -> String {
        let claims = JwtClaims {
            user_id: user_id.to_string(),
            email: Some("user@example.com".to_string()),
            exp,
            iat: None,
        };
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("encode test token")
    }

    // ── 1. Auth safety ────────────────────────────────────────────

    #[test]
    fn valid_token_extracts_correct_user_id() {
        let uid = "11111111-1111-1111-1111-111111111111";
        let token = make_token(uid, None);
        let claims = verify_jwt(&token, SECRET).expect("valid token must verify");
        assert_eq!(claims.user_id, uid);
    }

    #[test]
    fn invalid_signature_rejected() {
        let token = make_token("u1", None);
        let err = verify_jwt(&token, "a-different-wrong-secret").unwrap_err();
        assert!(matches!(err, AppError::Unauthorised(_)));
    }

    #[test]
    fn malformed_token_rejected() {
        let err = verify_jwt("this.is.not-a-real-jwt", SECRET).unwrap_err();
        assert!(matches!(err, AppError::Unauthorised(_)));
    }

    #[test]
    fn empty_token_rejected() {
        let err = verify_jwt("", SECRET).unwrap_err();
        assert!(matches!(err, AppError::Unauthorised(_)));
    }

    #[test]
    fn expired_token_rejected() {
        // exp = 1000 (1970-01-01T00:16:40Z) -- far in the past.
        let token = make_token("u1", Some(1000));
        let err = verify_jwt(&token, SECRET).unwrap_err();
        assert!(
            matches!(err, AppError::Unauthorised(_)),
            "an expired token must be rejected"
        );
    }

    #[test]
    fn token_without_exp_is_accepted() {
        // Node does not always set exp; such tokens must still verify.
        let token = make_token("u2", None);
        assert!(
            verify_jwt(&token, SECRET).is_ok(),
            "a token without exp must still verify (exp is optional)"
        );
    }

    #[test]
    fn future_exp_token_accepted() {
        // exp = 9999999999 (2286) -- comfortably in the future.
        let token = make_token("u3", Some(9_999_999_999));
        assert!(verify_jwt(&token, SECRET).is_ok());
    }

    // ── 4. Logging / token safety ─────────────────────────────────

    #[test]
    fn token_value_never_appears_in_error() {
        let token = make_token("u1", None);
        let err = verify_jwt(&token, "wrong-secret").unwrap_err();
        let combined = format!("{:?} || {}", err, err);
        assert!(
            !combined.contains(&token),
            "auth error must never contain the raw token string"
        );
    }

    #[test]
    fn extract_bearer_parses_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer abc.def.ghi".parse().unwrap());
        assert_eq!(extract_bearer(&headers), Some("abc.def.ghi"));
    }

    #[test]
    fn extract_bearer_requires_bearer_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "abc.def.ghi".parse().unwrap());
        assert_eq!(extract_bearer(&headers), None);
    }

    #[test]
    fn extract_bearer_missing_header_is_none() {
        let headers = HeaderMap::new();
        assert_eq!(extract_bearer(&headers), None);
    }
}
