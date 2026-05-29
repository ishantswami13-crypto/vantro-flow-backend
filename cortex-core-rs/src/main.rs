// FILE: cortex-core-rs/src/main.rs
// CLI entry point.
//
// Usage:
//   cortex-core '{"command":"score_customer","payload":{...}}'
//
// The command string is the discriminant used by serde's tag = "command".
// On success, prints a single JSON object to stdout and exits 0.
// On error, prints {"success":false,"error":"..."} to stdout and exits 1.
// Stderr is reserved for debug traces only; never written in production mode.

use cortex_core::{
    policy::evaluate_action_policy,
    scoring::score_customer,
    simulation::{simulate_cashflow_gap, simulate_credit_sale},
    types::{DispatchInput, DispatchOutput, ErrorOutput},
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        let err = serde_json::to_string(&ErrorOutput {
            success: false,
            error:   "Usage: cortex-core '<json>'".to_string(),
        })
        .unwrap_or_else(|_| r#"{"success":false,"error":"bad args"}"#.to_string());
        println!("{}", err);
        std::process::exit(1);
    }

    let input_str = &args[1];

    let result: DispatchOutput = match serde_json::from_str::<DispatchInput>(input_str) {
        Err(e) => DispatchOutput::Error(ErrorOutput {
            success: false,
            error:   format!("JSON parse error: {}", e),
        }),
        Ok(cmd) => dispatch(cmd),
    };

    match serde_json::to_string(&result) {
        Ok(json) => {
            println!("{}", json);
            // Non-success output should still exit 0 so Node can parse the error JSON.
            // Only hard panics / parse failures exit non-zero.
        }
        Err(e) => {
            println!(r#"{{"success":false,"error":"serialize failed: {}"}}"#, e);
            std::process::exit(1);
        }
    }
}

fn dispatch(cmd: DispatchInput) -> DispatchOutput {
    match cmd {
        DispatchInput::ScoreCustomer(m) | DispatchInput::CollectionPriority(m) => {
            DispatchOutput::Score(score_customer(&m))
        }
        DispatchInput::SimulateCreditSale(i) => {
            DispatchOutput::Simulation(simulate_credit_sale(&i))
        }
        DispatchInput::SimulateCashflowRisk(i) => {
            DispatchOutput::CashflowSim(simulate_cashflow_gap(&i))
        }
        DispatchInput::EvaluatePolicy(i) => {
            DispatchOutput::Policy(evaluate_action_policy(&i))
        }
    }
}
