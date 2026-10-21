# Sputnik DAO v2 WASM provenance

## Factory default used for NEAR testnet

- Factory: `sputnikv2.testnet`
- `get_default_code_hash()`: `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`
- `get_default_version()`: `[3, 31]`
- Factory metadata commit: `7764926cfd3c47f62b5fcde231c251f3c3892887`
- DAO checked: `routes-d040-3d597054.sputnikv2.testnet`
- DAO account/view code hash: `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`
- DAO `version()`: `2.3.1`
- Vendored file: `sputnikdao2-testnet-3.31-AA4nA45v.wasm`
- SHA-256: `880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da`
- Size: `539647` bytes
- Governance regression result: 9 passed, 0 failed

## Locally built comparison artifact

- Repository: <https://github.com/near-daos/sputnik-dao-contract>
- Package: `sputnikdao2` version `2.3.1`
- Commit: `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`
- Vendored file: `sputnikdao2-2.3.1-5434a59.wasm`
- SHA-256: `622921e1e45de6ba8cc278324f2e1160b5cd149280021fb8b6be81de50d10268`
- Build: `RUSTUP_TOOLCHAIN=1.86.0 cargo near build non-reproducible-wasm --manifest-path sputnikdao2/Cargo.toml`
- Governance regression result: 9 passed, 0 failed

The factory default and local build differ byte-for-byte, but the nine governance behaviors required by MandateOS pass on both. Tests select a specific artifact with `SPUTNIK_DAO_WASM`; the default remains the pinned local build so offline test runs are deterministic.

The repository also contains `sputnikdao2_original.wasm` (SHA-256 `6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f`). It predates the current `get_factory_info` interface and is not used.
