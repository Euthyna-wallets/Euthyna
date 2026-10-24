//! Prints the protocol sheets for fixed inputs as JSON. The TypeScript role
//! builder (`packages/sdk/src/roles.ts`) is tested against this output.
//!
//! cargo run -p omniroles-conditions --example presets_fixture > ../packages/sdk/src/fixtures/presets.json

use omniroles_conditions::presets::{self, PresetPermission};

fn main() {
    let usdc = [0x41; 20];
    let token_a = [0xaa; 20];
    let token_b = [0xbb; 20];
    let v3 = [0x94; 20];
    let v2 = [0x16; 20];
    let supplier = [0xa7; 20];
    let key = [0x5a; 32];
    let sheets: Vec<(&str, PresetPermission)> = vec![
        ("approve", presets::erc20_approve(usdc, &[v3, v2], 10_000_000_000)),
        ("approveSingle", presets::erc20_approve(usdc, &[v3], 1)),
        ("transfer", presets::erc20_transfer(usdc, &[supplier], key)),
        ("transferMany", presets::erc20_transfer(usdc, &[supplier, token_a], key)),
        ("uniswapV3", presets::uniswap_v3_exact_input_single(v3, usdc, &[token_a, token_b], key)),
        ("uniswapV3Single", presets::uniswap_v3_exact_input_single(v3, usdc, &[token_a], key)),
        ("uniswapV2", presets::uniswap_v2_swap_exact_tokens_for_tokens(v2, &[vec![usdc, token_a], vec![usdc, token_b]], key)),
        ("uniswapV2Single", presets::uniswap_v2_swap_exact_tokens_for_tokens(v2, &[vec![usdc, token_a]], key)),
    ];
    let json: serde_json::Map<String, serde_json::Value> = sheets
        .into_iter()
        .map(|(name, sheet)| {
            (
                name.to_string(),
                serde_json::json!({
                    "target": format!("0x{}", hex::encode(sheet.target)),
                    "selector": format!("0x{}", hex::encode(sheet.selector)),
                    "conditions": sheet.conditions,
                }),
            )
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&json).expect("json"));
}
