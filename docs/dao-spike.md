# DAO governance spike

## Conclusion

The spike proves in a NEAR sandbox that a three-member Sputnik DAO can be the sole owner and funder of a MandateOS contract:

- two council approvals execute `Vault.set_role`;
- one approval does not execute it;
- direct calls from a third party or one council member fail with `ERR_OWNER_ONLY`;
- a `Transfer` proposal with `msg` executes `ft_transfer_call` and credits the role budget;
- one `Transfer` proposal can create and fund a role through `ft_on_transfer`;
- a non-member cannot create a proposal;
- the DAO can set `auto_update: false`;
- an expired proposal cannot execute;
- the `VoteApprove` transaction that triggers the real Vault `FunctionCall` burnt **8.788 Tgas** (`8,788,073,606,162` gas units) in the observed sandbox run.

The tests remove the only access key from the Vault after deployment and assert that its access-key list is empty. Its `owner_id` is the DAO account, so only a promise emitted by the DAO contract can pass `set_role` authorization.

## Sputnik artifact

| Field | Value |
|---|---|
| Repository | [`near-daos/sputnik-dao-contract`](https://github.com/near-daos/sputnik-dao-contract) |
| Package | `sputnikdao2` `2.3.1` |
| Commit | `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` |
| Vendored WASM | `contracts/res/sputnikdao2-2.3.1-5434a59.wasm` |
| SHA-256 | `622921e1e45de6ba8cc278324f2e1160b5cd149280021fb8b6be81de50d10268` |

The repository root also contains `sputnikdao2_original.wasm`. The first automated run proved that this prebuilt artifact predates the current `get_factory_info` view. The spike therefore builds the official `sputnikdao2` source at the pinned commit and vendors the resulting WASM. Full provenance is in [`contracts/res/SPUTNIKDAO2_SOURCE.md`](../contracts/res/SPUTNIKDAO2_SOURCE.md).

### Live `sputnikv2.testnet` verification

The factory was queried through the NEAR testnet RPC before continuing with the Vault:

| Observation | Live value |
|---|---|
| Factory | `sputnikv2.testnet` |
| `get_default_code_hash()` | `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` |
| `get_default_version()` | `[3, 31]` |
| Factory metadata commit | `7764926cfd3c47f62b5fcde231c251f3c3892887` |
| Recent DAO checked | `routes-d040-3d597054.sputnikv2.testnet` |
| DAO account/view code hash | `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` |
| Downloaded WASM SHA-256 | `880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da` |
| Downloaded WASM size | `539647` bytes |
| DAO `version()` | `2.3.1` |

The live factory WASM differs from the locally built 2.3.1 artifact (`622921…`). It is vendored as `contracts/res/sputnikdao2-testnet-3.31-AA4nA45v.wasm`. The same nine tests were rerun with:

```bash
cd contracts
SPUTNIK_DAO_WASM=\"$PWD/res/sputnikdao2-testnet-3.31-AA4nA45v.wasm\" \
  cargo test -p tests -- --nocapture
```

Result with the real Vault: **9 passed, 0 failed**. The behaviors relevant to MandateOS did not differ. The triggering `VoteApprove` used 9.139 Tgas on the live factory WASM versus 8.788 Tgas on the pinned local build.

## Final policy

```json
{
  "roles": [
    {
      "name": "council",
      "kind": {
        "Group": [
          "member-1.testnet",
          "member-2.testnet",
          "member-3.testnet"
        ]
      },
      "permissions": [
        "*:AddProposal",
        "*:VoteApprove",
        "*:VoteReject",
        "*:VoteRemove",
        "*:Finalize"
      ],
      "vote_policy": {}
    }
  ],
  "default_vote_policy": {
    "weight_kind": "RoleWeight",
    "quorum": "0",
    "threshold": "2"
  },
  "proposal_bond": "100000000000000000000000",
  "proposal_period": "30000000000",
  "bounty_bond": "100000000000000000000000",
  "bounty_forgiveness_period": "30000000000"
}
```

Properties:

- `council` is the only role; there is no `Everyone` or mono-member role.
- `proposal_bond` is `0.1 NEAR` and is non-zero.
- `proposal_period` is 30 seconds for sandbox tests. Production must use a longer reviewed value.
- The default policy applies explicit weight `2` to the three-member `RoleWeight` group.

Sputnik matches every applicable role and ORs their permissions ([`policy.rs:L322-L358`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs#L322-L358)). A permissive second role would therefore weaken the council threshold. The default policy is unsafe for MandateOS because it grants `*:AddProposal` to `Everyone` ([`policy.rs:L179-L215`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs#L179-L215)).

### Why the final threshold is `"2"`, not `[2, 3]`

The requested ratio `[2, 3]` does **not** implement two-of-three in Sputnik DAO v2.3.1. `WeightOrRatio::Ratio` computes `floor(numerator × total / denominator) + 1` ([`policy.rs:L86-L106`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs#L86-L106)). With three members, `[2, 3]` therefore requires three votes. The test `ratio_two_thirds_requires_all_three_in_sputnik_v2_3_1` proves this behavior.

The final policy uses explicit `Weight("2")`, serialized as `"2"`, to obtain the required two approvals. Sputnik compares each role's approval count against that computed threshold and accepts as soon as one role reaches it ([`policy.rs:L378-L433`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs#L378-L433)).

`"2"` is an absolute weight, not a ratio. Every council membership change must therefore use a full `ChangePolicy` proposal that updates the `Group` and recalculates the threshold together. For a desired two-thirds threshold, MandateOS computes `ceil(2 × member_count / 3)`. `AddMemberToRole` and `RemoveMemberFromRole` are not used for council membership because they leave the absolute threshold unchanged.

## Test results

Command:

```bash
cd contracts
cargo test -p tests -- --nocapture
```

Observed result: **9 passed, 0 failed**.

| # | Test | Result |
|---:|---|---|
| 1 | `function_call_requires_two_votes_and_then_executes` | One vote leaves the proposal `InProgress`; vote two executes `set_role`. |
| 2 | `set_role_rejects_outsider_and_single_council_member` | Both direct calls panic with `ERR_OWNER_ONLY`. |
| 3 | `transfer_with_msg_credits_existing_role_atomically` | `Transfer` calls `ft_transfer_call`; the role budget increases by `50,000,000` units. |
| 4 | `one_transfer_proposal_can_create_and_fund_role` | One proposal creates `compta-bot` and credits its budget in `ft_on_transfer`. |
| 5 | `non_member_cannot_add_proposal` | The call fails with `ERR_PERMISSION_DENIED`. |
| 6 | `factory_auto_update_can_be_disabled_by_vote` | `get_factory_info().auto_update` changes from `true` to `false`. |
| 7 | `expired_proposal_cannot_execute` | The late vote marks the proposal `Expired`; the target role is absent. |
| 8 | `vote_approve_execution_gas_is_measured` | Real Vault target; observed total gas burnt: **8.788 Tgas** (`8,788,073,606,162` gas units). |
| — | `ratio_two_thirds_requires_all_three_in_sputnik_v2_3_1` | Confirms the ratio-threshold discrepancy described above. |

Sputnik requires the exact proposal bond before accepting a proposal and checks `AddProposal` permission on the caller ([`proposals.rs:L531-L588`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/proposals.rs#L531-L588)). Expiration is evaluated before vote thresholds ([`policy.rs:L378-L396`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/policy.rs#L378-L396)).

## Creation and funding in one vote

### What works

A `Transfer` proposal with a non-empty `msg` invokes `ft_transfer_call` ([`proposals.rs:L90-L99`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/proposals.rs#L90-L99), [`proposals.rs:L309-L336`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/proposals.rs#L309-L336)). `Vault.ft_on_transfer` accepts this message:

```json
{
  "role": "compta-bot",
  "config": {
    "max_per_tx": "10000000",
    "enabled": true
  }
}
```

If the role does not exist, the receiver creates it and credits the transferred amount in the same cross-contract execution. The DAO remains the FT sender and the only accepted funder.

### What does not work

A Sputnik `FunctionCall` proposal has one `receiver_id` for all actions ([`proposals.rs:L76-L81`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/proposals.rs#L76-L81)). It can batch several methods on the Vault, but it cannot call `Vault.set_role` and then call a different FT contract in the same proposal. Sputnik constructs every action in that proposal against the same receiver ([`proposals.rs:L379-L392`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/proposals.rs#L379-L392)).

Decision: use `Transfer.msg` → `ft_transfer_call` → `ft_on_transfer` as the atomic role-creation and funding path.

## Auto-update

Sputnik initializes `FactoryInfo` with `auto_update: true` ([`lib.rs:L95-L120`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/lib.rs#L95-L120)). `FactoryInfoUpdate` writes the new value when an approved proposal executes ([`proposals.rs:L432-L435`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao2/src/proposals.rs#L432-L435)). The test proves that the council can disable it.

MandateOS must submit this proposal immediately after DAO creation and verify `get_factory_info().auto_update == false` before treating the DAO as production-ready.

## Gas

The second `VoteApprove`, which reached threshold and executed the real Vault target plus Sputnik's callback, burnt **8.788 Tgas** (`8,788,073,606,162` gas units) in the observed sandbox execution. This is a baseline for `set_role` only.

The real testnet Vault's complete `authorize → v1.signer-prod.testnet → callback` path burnt 14.437 Tgas. The MPC contract's live configuration requires 15 Tgas on the `sign` receipt; the Vault additionally reserves callback gas.

## Testnet creation through the verified factory

The official testnet scripts set `FACTORY_ACCOUNT_ID=sputnikv2.testnet` ([`deploy_factory_testnet.sh:L12-L17`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/scripts/deploy_factory_testnet.sh#L12-L17)). The current factory `create` method derives `<name>.<factory>`, deploys the default DAO code and calls `new` with the supplied Base64 arguments ([`sputnikdao-factory2/src/lib.rs:L71-L88`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao-factory2/src/lib.rs#L71-L88)). Its creation batch does not add an access key ([`factory_manager.rs:L75-L121`](https://github.com/near-daos/sputnik-dao-contract/blob/5434a59dec23ee0c49df8c8c4350c208a7e75b0b/sputnikdao-factory2/src/factory_manager.rs#L75-L121)).

Set real testnet member accounts before running:

```bash
export FACTORY_ID=sputnikv2.testnet
export DAO_NAME=acme-mandateos
export DAO_ID="$DAO_NAME.$FACTORY_ID"
export CREATOR=your-account.testnet
export MEMBER_1=member-1.testnet
export MEMBER_2=member-2.testnet
export MEMBER_3=member-3.testnet
```

Construct the same policy used by the tests:

```bash
export DAO_INIT_ARGS="$(jq -cn \
  --arg m1 "$MEMBER_1" \
  --arg m2 "$MEMBER_2" \
  --arg m3 "$MEMBER_3" \
  '{
    config: {
      name: "ACME MandateOS DAO",
      purpose: "Govern MandateOS contracts",
      metadata: ""
    },
    policy: {
      roles: [{
        name: "council",
        kind: {Group: [$m1, $m2, $m3]},
        permissions: [
          "*:AddProposal",
          "*:VoteApprove",
          "*:VoteReject",
          "*:VoteRemove",
          "*:Finalize"
        ],
        vote_policy: {}
      }],
      default_vote_policy: {
        weight_kind: "RoleWeight",
        quorum: "0",
        threshold: "2"
      },
      proposal_bond: "100000000000000000000000",
      proposal_period: "30000000000",
      bounty_bond: "100000000000000000000000",
      bounty_forgiveness_period: "30000000000"
    }
  }')"

export DAO_INIT_ARGS_B64="$(printf '%s' "$DAO_INIT_ARGS" | base64 -w0)"
export FACTORY_CREATE_ARGS="$(jq -cn \
  --arg name "$DAO_NAME" \
  --arg args "$DAO_INIT_ARGS_B64" \
  '{name: $name, args: $args}')"
```

Create the DAO:

```bash
near contract call-function as-transaction "$FACTORY_ID" create \
  json-args "$FACTORY_CREATE_ARGS" \
  prepaid-gas '150 Tgas' \
  attached-deposit '6 NEAR' \
  sign-as "$CREATOR" \
  network-config testnet \
  sign-with-keychain send
```

Verify the deployed policy and factory state:

```bash
near contract call-function as-read-only "$DAO_ID" get_policy \
  json-args '{}' network-config testnet now

near contract call-function as-read-only "$DAO_ID" get_factory_info \
  json-args '{}' network-config testnet now
```

The current official NEAR DAO primitive uses a 6 NEAR deposit for `sputnikv2.testnet` ([NEAR DAO documentation](https://docs.near.org/primitives/dao#create-a-dao)). The observed three-member MandateOS DAO uses 540,372 bytes, or 5.40372 NEAR at the live `10^19` yoctoNEAR/byte storage price, leaving 0.59628 NEAR for state growth and gas. Recheck the factory's default code hash and protocol storage price immediately before a real deployment.

### MandateOS global factory

For the hackathon multi-Company flow, `factory.mandateos.testnet` reuses the
official immutable Sputnik global hash
`Ea8tHXFSQVszVwGASyzAfLq65DjcRDhkfab4FcPaRpgD` instead of duplicating the DAO
WASM. The factory is owner-only, has zero access keys and transfers the attached
balance into `<slug>.factory.mandateos.testnet` before `new`.

Observed proof:

- factory deployment: `GJgBDDpjcznHwnzZFjsGb2GS61PQopXnfhgwEvCBzeH9`;
- DAO creation: `5zMZUBfP9cvkSDunnSM5SL5N9RDU6rvDASBk8C67sXJH`;
- DAO: `global-smoke.factory.mandateos.testnet`;
- `global_contract_hash` equals the configured immutable hash;
- zero access keys, threshold `2`, three council members;
- balance `0.25 NEAR`, storage usage `810` bytes (`0.00810 NEAR` minimum).

The standard 6 NEAR `sputnikv2.testnet` path remains a compatibility fallback;
the MandateOS factory is the default hackathon path.

## Surprises and operational notes

1. `[2,3]` means three-of-three for a three-member group in this Sputnik implementation; explicit weight `"2"` is required.
2. The repository's `sputnikdao2_original.wasm` lacks the current `get_factory_info` view. The pinned source build is used instead.
3. Current near-sdk JSON serialization expects `ActionCall.gas` as a decimal string.
4. NEAR Sandbox emitted host kernel-parameter warnings during the run, but all transactions and all nine tests completed successfully.
5. The DAO `set_role` measurement and the MPC `authorize` measurement cover different paths; neither includes Base broadcast gas.
