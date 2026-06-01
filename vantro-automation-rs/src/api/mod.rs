use crate::AppState;
use axum::Router;

mod bootstrap;
mod cost;
mod cost_router;
mod data_quality;
mod health;
mod policy;
mod policy_guard;
mod scoring;
mod simulate;

pub fn routes(state: AppState) -> Router<AppState> {
    Router::new()
        .merge(health::routes())
        .merge(bootstrap::routes())
        .merge(scoring::routes())
        .merge(simulate::routes())
        .merge(policy::routes())
        .merge(policy_guard::routes())
        .merge(cost_router::routes())
        .merge(cost::routes())
        .merge(data_quality::routes())
        .with_state(state)
}
