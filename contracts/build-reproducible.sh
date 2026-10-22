#!/usr/bin/env bash
set -euo pipefail

for manifest in \
  dao-factory/Cargo.toml \
  vault/Cargo.toml \
  governance-relay/Cargo.toml
do
  cargo near build reproducible-wasm --manifest-path "$manifest"
done

sha256sum \
  target/near/dao_factory/dao_factory.wasm \
  target/near/vault/vault.wasm \
  target/near/governance_relay/governance_relay.wasm
