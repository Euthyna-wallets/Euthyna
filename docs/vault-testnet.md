# Euthyna Vault — NEAR testnet spike

## Status

The security-corrected Vault contract is implemented in `contracts/vault`. It constructs configurable-chain EIP-1559 transactions, validates Guard visas and treats every MPC request as potentially public. The deployed UAT WASM SHA-256 is `11cb6f034b43915b313bcb7e62886a0152a4060e46776615159f95f41d9acc21`; deployment and reproducible-build hashes are kept distinct below.

Local verification:

```bash
cd contracts
./build.sh
cargo test --workspace
./build-reproducible.sh
```

Observed result: **28 passed, 0 failed** across the DAO, Vault, governance-relay and factory suites.

The reproducible build metadata in each production contract pins
`sourcescan/cargo-near:0.20.3-rust-1.86.0` by digest
`sha256:a84b7c401a856b6bbbe1975f235b6a8011540a24dfbde248531cccb4b2fdbadf`.
The factory and Vault were reproduced from `255b04a`; the relay wallet-proof
views were reproduced from `aa85684859e72a4d0526b85ecc042e1def6f1231`:

| Contract | Bytes | Reproducible SHA-256 hex |
|---|---:|---|
| DAO factory | 150,945 | `ad1ed251fc4a556a3070de31c64c2b43442f0ebf5dc1dcf299ba532945312c92` |
| Vault | 439,658 | `cac18ad40a3d04cc7945c8ac3d1a1677197078130b5dbaed62a94234ee8a1538` |
| Governance relay | 286,385 | `921c03c78a759dc11976501f5b8f81a514820dad57d62e3f28c0cf12034767f5` |

The relay Base58 code hash is
`AqMJR7ftwLs78D9ERv3eVZpAy8DjobFANTWZ6awc1Vnc`. Its read-only
`mpc_contract_id` and `mpc_path` views let each member verify the complete
deployment directly from NEAR RPC.

These hashes do not silently replace the already deployed/keyless UAT
artifacts. A deployment cutover must update the manifest and re-run on-chain
code-hash verification explicitly.

## Testnet deployment

The machine-readable manifests are [`deployments/near-testnet.json`](../deployments/near-testnet.json) and [`deployments/base-sepolia.json`](../deployments/base-sepolia.json). The corrected deployment completed a real end-to-end payment.

| Component | Account / value |
|---|---|
| Sputnik factory | `sputnikv2.testnet` |
| DAO | `mandateos-uat-92543787.sputnikv2.testnet` |
| Vault | `vault-v4.mandateos-root-20261021.testnet` |
| Test FT | `test-ft-v4.mandateos-root-20261021.testnet` |
| Agent | `agent-v4.mandateos-root-20261021.testnet` |
| MPC | `v1.signer-prod.testnet` |
| Derived Base address | `0x10EdE0F3C618321919934Fd63df173DD37F037Af` |
| Vault code hash | `2CTrDibuU42kqQBxNpQRkABgjYk5AuGLcv3mdefpyv9n` |
| Vault access keys | `0` |
| DAO access keys | `0` |
| DAO auto-update | `false` |
| EVM chain ID | `84532` |
| Final operation state | `Confirmed` |
| `authorize` gas burnt | `14.288425743215 Tgas` |
| Base payment | `0x0bf66f0c192ee3874d8f69af9fc704d0abd616f8162390521fbaed088d8e4ea4` |
| NEAR confirmation | `8u2G2cZrxwviWYnKqnGm4W59XMeCK9K2QrFVCM9qGTmK` |

The live MPC call used 1 yoctoNEAR and returned a valid secp256k1 signature. Base Sepolia included the signed EIP-1559 transaction successfully; 1 TestUSDC (token de test) moved from the Safe to the registered recipient. The Guard-signed report then moved the Vault operation from `PossiblySigned` to `Confirmed`.

The DAO-owned governance relay is `gov-relay-v1.mandateos-root-20261021.testnet`, with no access keys. It derives `0xGOV = 0xC9635C52861f6a68e4E27FaD8f3c663d4c11FDBb`, which is the sole Delay module. Proposal `19` raised the researcher allowance to 10 TestUSDC (token de test) after the 300-second Sepolia cooldown. Proposal `23` attempted a 1 000 TestUSDC (token de test) allowance; the Safe council vetoed it with `setTxNonce(3)`, and the post-veto execution reverted.

## Contract responsibilities

### `prepare(intent)`

`prepare`:

1. verifies that the Vault and agent are active;
2. resolves the agent's role and previously derived `0xAAA` address;
3. permits only one non-terminal operation per agent;
4. checks token, recipient, amount and gas ceilings;
5. checks funded minus spent minus reserved budget;
6. reserves the amount and business reference;
7. assigns the current EVM nonce without advancing it;
8. ABI-encodes `USDC.transfer` inside `Roles.execTransactionWithRole`;
9. builds the Base transaction with `omni-transaction` 0.3;
10. hashes the EIP-1559 signing preimage with Keccak-256;
11. persists `Prepared` with a short block-height TTL.

The transaction fixes:

```text
chain_id = 84532
to = Roles Modifier
value = 0
data = execTransactionWithRole(
  USDC,
  0,
  USDC.transfer(recipient, amount),
  Call,
  roleKey,
  true
)
```

`gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas` and their maximum product are checked against the role and included in the signed digest.

### `authorize(op_id, approval)`

The signed message is exactly:

```text
UTF8("mandateos:visa:v1") || BORSH(GuardVisa)
```

The Vault verifies:

- ed25519 signature;
- `client_id`;
- `op_id` and exact transaction digest;
- agent, role and reference;
- policy and registry versions;
- visa and operation expirations;
- one-time `visa_nonce`.

It consumes `visa_nonce`, advances the agent's EVM nonce and moves the operation to `PossiblySigned` **before** the external call:

```json
{
  "request": {
    "path": "agents/researcher/base",
    "payload_v2": { "Ecdsa": "<32-byte digest as hex>" },
    "domain_id": 0
  }
}
```

The MPC callback stores `(big_r, s, recovery_id)` and assembles the signed EIP-1559 transaction when a response is available. If the callback fails, `submit_signature` accepts the published signature only when `ecrecover` returns the agent address for the exact original or cancellation digest, then stores the same fields. Neither path decides whether budget, reference or nonce can be released.

### Failure handling

- Prepared expiration before `authorize` releases budget/reference and leaves the nonce reusable.
- From `authorize`, the operation is `PossiblySigned`; MPC failure, timeout and late response do not release budget, reference or nonce.
- `pause` and `revoke_agent` preserve the reservation and permit the emergency worker to call `cancel_nonce`.
- `cancel_nonce` signs a zero-value transaction to `0xAAA` at the same nonce with higher bounded fees.
- Only confirmed inclusion of that cancellation, reported by the DAO owner, moves the operation to `Cancelled` and releases its reservation.
- A Guard-signed report can only confirm the exact stored original transaction and move the operation to `Confirmed`.
- A revert never reopens an operation automatically.

## Derived address

The Vault asks the MPC view with:

```json
{
  "path": "agents/researcher/base",
  "predecessor": "<vault account>",
  "domain_id": 0
}
```

It Base58-decodes the returned 64-byte secp256k1 public key and computes:

```text
0xAAA = last20bytes(keccak256(uncompressed_x_y))
```

The local test computes the same address independently and compares it with both the contract helper and stored agent state. The current testnet Vault derived `0x10EdE0F3C618321919934Fd63df173DD37F037Af`; Roles granted that exact address and revoked the superseded researcher address before broadcast.

## Local test coverage

| Test area | Proof |
|---|---|
| Visa | missing, modified, expired and replayed visas rejected |
| Budget | over-budget intent rejected |
| Idempotence | consumed reference rejected |
| Concurrency | second active `prepare` rejected |
| Circuit breakers | `pause`/`revoke_agent` keep reservation and allow emergency cancellation |
| Pre-authorize expiration | reservation released and nonce reused |
| `PossiblySigned` | MPC failure keeps budget/reference/nonce locked |
| Late MPC response | signature can arrive later; nonce remains unavailable |
| Cancellation | same nonce, self-transfer, higher fees; confirmed cancellation consumes nonce |
| Confirmation | domain-separated Guard report confirms only the exact original raw transaction |
| Derivation | host and contract derive the same `0xAAA` |
| EVM construction | chain 84532, Roles selector and nested ERC-20 selector verified |

## NEAR gas sponsorship

Euthyna will pay agent-side NEAR gas through a NEP-366 relayer. Agents sign `DelegateAction` objects with their restricted function-call keys; the funded Euthyna relayer submits them after validating sender, client, Vault receiver, method allowlist, zero deposit and per-client gas quota.

That relayer is architectural scope, not implemented in this Vault spike. The testnet smoke used faucet-funded development accounts. The Vault itself pays the 1 yoctoNEAR MPC deposit and its outgoing receipt gas from its operational balance.

## Reproduction and deployment

Rebuild local test artifacts:

```bash
cd contracts
./build.sh
./build-reproducible.sh
cargo test --workspace
```

Repeat the testnet deployment with a fresh DAO and Vault:

```bash
cargo run -p tests --example deploy_vault_testnet
```

The example creates throwaway testnet accounts and uses a deterministic Guard test key. Production deployment must instead use the console/KMS Guard key, reviewed Base addresses and the NEP-366 sponsor relayer.
