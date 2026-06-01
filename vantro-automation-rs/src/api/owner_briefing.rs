use axum::{extract::State, routing::post, Json, Router};
use tracing::{error, info, instrument};

use crate::{
    agents::owner_briefing::{
        generate_owner_briefing, OwnerBriefingInput, OwnerBriefingOutput,
    },
    auth::AuthUser,
    error::AppResult,
    AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v2/agents/core.owner_briefing/preview",
        post(evaluate_owner_briefing),
    )
}

#[instrument(skip(state, input))]
async fn evaluate_owner_briefing(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<OwnerBriefingInput>,
) -> AppResult<Json<OwnerBriefingOutput>> {
    info!(user_id = %user.user_id, "core.owner_briefing requested");

    let pool = state.db.clone();
    let result = generate_owner_briefing(&pool, user.user_id, input).await?;

    info!(
        user_id = %user.user_id,
        duration_ms = result.duration_ms,
        total_actions = result.total_actions,
        "core.owner_briefing generated successfully"
    );

    Ok(Json(result))
}
