use crate::AppState;
use axum::Router;

mod bootstrap;
mod cost;
mod data_quality;
mod health;
mod policy;
mod scoring;
mod simulate;

pub fn routes(state: AppState) -> Router<AppState> {
    Router::new()
        .merge(health::routes())
        .merge(bootstrap::routes())
        .merge(scoring::routes())
        .merge(simulate::routes())
        .merge(policy::routes())
        .merge(cost::routes())
        .merge(data_quality::routes())
        .with_state(state)
}
