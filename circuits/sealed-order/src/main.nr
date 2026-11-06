// A sealed order: swap `token_in` for `token_out` on `chain_id` once the market gives at least a hidden
// rate, for at most a hidden total, before a hidden date. The vault's DAO stores only
//   commitment = Poseidon2(vault_tag, chain_id, token_in, token_out, fee, limit_rate, cap, expiry, salt).
// A fill proves, without revealing limit_rate, cap, expiry or salt:
//   - the commitment opens to this pair, on this chain, for this vault;
//   - the rate the swap will demand (`rate`, out per in, scaled by 1e18) is at least the hidden limit;
//   - what was already filled plus this fill stays within the hidden cap;
//   - the order has not expired at `now`.
// The swap's minimum output is derived from `rate` by the contract, so a fill that claims a better rate
// than the market reverts on chain: a false `rate` can only make a fill fail, never trade worse.
use poseidon::poseidon2::Poseidon2;

pub fn commitment_of(
    vault_tag: Field,
    chain_id: Field,
    token_in: Field,
    token_out: Field,
    fee: Field,
    limit_rate: u128,
    cap: u128,
    expiry: u64,
    salt: Field,
) -> Field {
    Poseidon2::hash(
        [vault_tag, chain_id, token_in, token_out, fee, limit_rate as Field, cap as Field, expiry as Field, salt],
        9,
    )
}

fn main(
    commitment: pub Field,
    vault_tag: pub Field,
    chain_id: pub Field,
    token_in: pub Field,
    token_out: pub Field,
    fee: pub Field,
    amount_in: pub u128,
    filled_before: pub u128,
    rate: pub u128,
    now: pub u64,
    limit_rate: u128,
    cap: u128,
    expiry: u64,
    salt: Field,
) {
    assert(
        commitment_of(vault_tag, chain_id, token_in, token_out, fee, limit_rate, cap, expiry, salt) == commitment,
        "commitment",
    );
    assert(amount_in > 0, "amount");
    assert(rate >= limit_rate, "rate below the limit");
    assert(filled_before + amount_in <= cap, "over the cap");
    assert(now <= expiry, "expired");
}

#[test]
fn fills_within_the_hidden_terms() {
    let c = commitment_of(7, 84532, 0xaa, 0xbb, 3000, 300, 1000, 2000, 42);
    main(c, 7, 84532, 0xaa, 0xbb, 3000, 400, 500, 301, 1999, 300, 1000, 2000, 42);
}

#[test(should_fail_with = "rate below the limit")]
fn refuses_a_worse_rate() {
    let c = commitment_of(7, 84532, 0xaa, 0xbb, 3000, 300, 1000, 2000, 42);
    main(c, 7, 84532, 0xaa, 0xbb, 3000, 400, 0, 299, 1999, 300, 1000, 2000, 42);
}

#[test(should_fail_with = "over the cap")]
fn refuses_more_than_the_cap() {
    let c = commitment_of(7, 84532, 0xaa, 0xbb, 3000, 300, 1000, 2000, 42);
    main(c, 7, 84532, 0xaa, 0xbb, 3000, 501, 500, 301, 1999, 300, 1000, 2000, 42);
}

#[test(should_fail_with = "expired")]
fn refuses_after_expiry() {
    let c = commitment_of(7, 84532, 0xaa, 0xbb, 3000, 300, 1000, 2000, 42);
    main(c, 7, 84532, 0xaa, 0xbb, 3000, 1, 0, 301, 2001, 300, 1000, 2000, 42);
}

#[test(should_fail_with = "commitment")]
fn refuses_another_pair() {
    let c = commitment_of(7, 84532, 0xaa, 0xbb, 3000, 300, 1000, 2000, 42);
    main(c, 7, 84532, 0xbb, 0xaa, 3000, 1, 0, 301, 1999, 300, 1000, 2000, 42);
}

#[test(should_fail_with = "commitment")]
fn refuses_another_vault() {
    let c = commitment_of(7, 84532, 0xaa, 0xbb, 3000, 300, 1000, 2000, 42);
    main(c, 8, 84532, 0xaa, 0xbb, 3000, 1, 0, 301, 1999, 300, 1000, 2000, 42);
}

#[test]
fn known_commitment() {
    // Pinned so the TypeScript side (bb.js poseidon2Hash) can check it computes the same value.
    let c = commitment_of(1, 2, 3, 4, 5, 6, 7, 8, 9);
    std::println(c);
}
