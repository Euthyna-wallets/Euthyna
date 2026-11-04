# Vendored Rust crates

## ultrahonk-no-std (from [zkVerify/ultrahonk_verifier](https://github.com/zkVerify/ultrahonk_verifier) v0.4.0, commit `610d689`, MIT/Apache-2.0)

A Rust port of Noir's UltraHonk Solidity verifier, used by `contracts/email-recovery` to verify
ZK Email proofs on chain. One change, behind the `near` feature: the final pairing check calls
NEAR's `alt_bn128_pairing_check` host function on the same two pairs instead of computing the
pairing in WebAssembly (about 150 Tgas cheaper). The multi-scalar multiplication goes through the
crate's own `CurveHooks`, which `contracts/email-recovery` implements with
`alt_bn128_g1_multiexp`. Diff: `diff -ru <upstream v0.4.0> contracts/vendor/ultrahonk-no-std`,
or search `Euthyna patch` in `src/lib.rs` and `near` in `Cargo.toml`.
