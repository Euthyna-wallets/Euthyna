#!/usr/bin/env bash
set -euo pipefail

RUSTUP_TOOLCHAIN=1.86.0 cargo near build non-reproducible-wasm --manifest-path vault/Cargo.toml
RUSTUP_TOOLCHAIN=1.86.0 cargo near build non-reproducible-wasm --manifest-path dao-factory/Cargo.toml
RUSTUP_TOOLCHAIN=1.86.0 cargo near build non-reproducible-wasm --manifest-path mock-mpc/Cargo.toml
RUSTUP_TOOLCHAIN=1.86.0 cargo near build non-reproducible-wasm --manifest-path test-ft/Cargo.toml

cp target/near/vault/vault.wasm res/vault.wasm
cp target/near/dao_factory/dao_factory.wasm res/dao_factory.wasm
cp target/near/mock_mpc/mock_mpc.wasm res/mock_mpc.wasm
cp target/near/test_ft/test_ft.wasm res/test_ft.wasm
