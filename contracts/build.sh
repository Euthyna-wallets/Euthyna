#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export RUSTUP_TOOLCHAIN=1.99.1

# cargo near validates the SDK's minimum protocol and embeds the contract ABI.
for contract in vault nomos dao-factory mock-mpc test-ft leash shares registry email-recovery sealed-orders; do
  cargo near build non-reproducible-wasm --locked --manifest-path "$contract/Cargo.toml"
done

build_target_dir=$(cargo metadata --format-version 1 --no-deps --manifest-path Cargo.toml | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
mkdir -p res
for contract in vault nomos dao_factory mock_mpc test_ft leash shares registry email_recovery sealed_orders; do
  cp "$build_target_dir/near/$contract/$contract.wasm" "res/$contract.wasm"
done
sha256sum res/vault.wasm res/nomos.wasm res/dao_factory.wasm res/mock_mpc.wasm res/test_ft.wasm res/leash.wasm res/shares.wasm res/registry.wasm res/email_recovery.wasm res/sealed_orders.wasm
