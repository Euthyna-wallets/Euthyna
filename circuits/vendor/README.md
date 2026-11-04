# Vendored Noir libraries

The recovery circuit needs **real zero-knowledge proofs**, which need bb 5 or later:
bb 0.84 only makes "plain" UltraHonk proofs, which do not promise to hide the
witness (the email), and the ZK variant of every bb before 5.0.0 has an unsound
SmallSubgroupIPA ([zkVerify's verifier README](https://github.com/zkVerify/ultrahonk_verifier)).
bb 5 needs Noir 1.0.0-beta.22 or later, and the last release of zkemail.nr (v2.0.0,
2026-03-03) does not compile with it. So these two libraries are copied here and
patched for Noir 1.0.0-beta.26, with the smallest changes that compile.

## zkemail (from [zkemail.nr](https://github.com/zkemail/zkemail.nr) v2.0.0, `lib/`, commit `8264758`, MIT)

The whole diff is in [zkemail.patch](./zkemail.patch). In short:

- dependencies moved to releases that compile with beta.26: noir-bignum v0.11.0, noir_base64 v0.5.1,
  nodash v0.46.0, sha256 v0.3.0, poseidon v0.4.0; noir_rsa is the patched copy below;
- removed modules the recovery circuit does not use: `masking`, `partial_hash`, `remove_soft_line_breaks`, `tests`;
- `KEY_LIMBS_*`, `MAX_EMAIL_ADDRESS_LENGTH`, `RSA_EXPONENT` and the fields of `Sequence` are now `pub`
  (Noir now enforces module privacy);
- array indexes cast from `u8` to `u32` (now required);
- `sha256_var` takes the length as `u32` (sha256 v0.3.0);
- `get_email_address` builds its result with `BoundedVec::from_parts_unchecked` instead of writing
  the private `len` field: same storage, same length, same checks.

The audited logic (DKIM signature, header field and address constraints) is unchanged.

## noir_rsa (from [noir_rsa](https://github.com/noir-lang/noir_rsa) v0.7.0, Apache-2.0)

Only `Nargo.toml` changes: noir-bignum v0.6.0 → v0.11.0. Note for callers: noir-bignum v0.11
computes its Barrett parameter as `2^(2·2048 + 6) / modulus` (it was `+ 4`), so `redc` in the
circuit inputs uses `+ 6`.
