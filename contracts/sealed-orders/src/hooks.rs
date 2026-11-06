//! BN254 operations for the UltraHonk verifier, on NEAR's host functions.
//!
//! The verifier does one large G1 multi-scalar multiplication and one pairing check. The
//! pairing goes through the vendored crate's `near` feature (`alt_bn128_pairing_check`); the
//! multi-scalar multiplication goes through these hooks (`alt_bn128_g1_multiexp`). G2 scalar
//! multiplication is only used to check the two constant SRS points, in software.

use ark_bn254_ext::{CurveHooks, Fq, Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::CurveGroup;
use ark_ec::pairing::Pairing;
use ark_ec::short_weierstrass::SWCurveConfig;
use ark_ff::{BigInteger, PrimeField};
use near_sdk::env;

#[derive(Default)]
pub struct NearHooks;

type Bn = ark_bn254_ext::Bn254<NearHooks>;

fn put_fq(out: &mut Vec<u8>, value: &Fq) {
    out.extend_from_slice(&value.into_bigint().to_bytes_le());
}

impl CurveHooks for NearHooks {
    fn bn254_multi_miller_loop(
        _g1: impl Iterator<Item = <Bn as Pairing>::G1Prepared>,
        _g2: impl Iterator<Item = <Bn as Pairing>::G2Prepared>,
    ) -> Result<<Bn as Pairing>::TargetField, ()> {
        // The vendored verifier calls alt_bn128_pairing_check instead (feature "near").
        Err(())
    }

    fn bn254_final_exponentiation(
        _target: <Bn as Pairing>::TargetField,
    ) -> Result<<Bn as Pairing>::TargetField, ()> {
        Err(())
    }

    fn bn254_msm_g1(bases: &[G1Affine<Self>], scalars: &[Fr]) -> Result<G1Projective<Self>, ()> {
        if bases.len() != scalars.len() {
            return Err(());
        }
        // alt_bn128_g1_multiexp: (x, y, scalar) little-endian 32 bytes each; infinity is (0, 0).
        let mut input = Vec::with_capacity(bases.len() * 96);
        for (point, scalar) in bases.iter().zip(scalars) {
            if point.infinity {
                input.extend_from_slice(&[0u8; 64]);
            } else {
                put_fq(&mut input, &point.x);
                put_fq(&mut input, &point.y);
            }
            input.extend_from_slice(&scalar.into_bigint().to_bytes_le());
        }
        let out = env::alt_bn128_g1_multiexp(&input);
        if out.len() != 64 {
            return Err(());
        }
        if out.iter().all(|byte| *byte == 0) {
            return Ok(G1Affine::<Self>::identity().into());
        }
        let x = Fq::from_le_bytes_mod_order(&out[..32]);
        let y = Fq::from_le_bytes_mod_order(&out[32..]);
        let point = G1Affine::<Self>::new_unchecked(x, y);
        if !point.is_on_curve() {
            return Err(());
        }
        Ok(point.into())
    }

    fn bn254_msm_g2(_bases: &[G2Affine<Self>], _scalars: &[Fr]) -> Result<G2Projective<Self>, ()> {
        Err(())
    }

    fn bn254_mul_projective_g1(
        base: &G1Projective<Self>,
        scalar: &[u64],
    ) -> Result<G1Projective<Self>, ()> {
        let limbs: [u64; 4] = scalar.try_into().map_err(|_| ())?;
        match Fr::from_bigint(ark_ff::BigInt::<4>(limbs)) {
            Some(scalar) => Self::bn254_msm_g1(&[base.into_affine()], &[scalar]),
            None => {
                let affine = base.into_affine();
                let point: ark_bn254::G1Projective = if affine.infinity {
                    ark_bn254::G1Affine::identity().into()
                } else {
                    ark_bn254::G1Affine::new_unchecked(affine.x, affine.y).into()
                };
                let result =
                    <ark_bn254::g1::Config as SWCurveConfig>::mul_projective(&point, scalar)
                        .into_affine();
                Ok(if result.infinity {
                    G1Affine::<Self>::identity().into()
                } else {
                    G1Affine::<Self>::new_unchecked(result.x, result.y).into()
                })
            }
        }
    }

    fn bn254_mul_projective_g2(
        base: &G2Projective<Self>,
        scalar: &[u64],
    ) -> Result<G2Projective<Self>, ()> {
        // In software, on arkworks' own BN254 types (only the SRS points' subgroup check).
        let affine = base.into_affine();
        let point: ark_bn254::G2Projective = if affine.infinity {
            ark_bn254::G2Affine::identity().into()
        } else {
            ark_bn254::G2Affine::new_unchecked(affine.x, affine.y).into()
        };
        let result =
            <ark_bn254::g2::Config as SWCurveConfig>::mul_projective(&point, scalar).into_affine();
        Ok(if result.infinity {
            G2Affine::<Self>::identity().into()
        } else {
            G2Affine::<Self>::new_unchecked(result.x, result.y).into()
        })
    }
}
