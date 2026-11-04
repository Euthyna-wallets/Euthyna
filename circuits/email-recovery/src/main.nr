use std::{collections::bounded_vec::BoundedVec, hash::pedersen_hash};
use zkemail::{
    dkim::RSAPubkey, headers::{constrain_header_field, email_address::get_email_address},
    KEY_LIMBS_2048, MAX_EMAIL_ADDRESS_LENGTH, Sequence,
};

/// Signed headers only (DKIM relaxed canonical form). Gmail's are well under this.
global MAX_EMAIL_HEADER_LENGTH: u32 = 1024;
global MAX_SUBJECT_LENGTH: u32 = 96;
global MAX_DOMAIN_LENGTH: u32 = 64;

/**
 * Euthyna seat recovery: "the owner of this mailbox sent an email with this subject".
 *
 * Proves that the header is signed by the 2048-bit DKIM key given as a public input (the
 * recovery contract checks that key is in its DKIM registry for the domain), and reveals only:
 *   0. a salted hash of the sender's address (lowercased): the same mailbox and salt give the
 *      same hash; the salt is public and chosen at enrollment,
 *   1. the sender's domain, so the verifier knows which DNS key to expect,
 *   2. the subject, which carries the action and the NEAR account it is bound to.
 * The address itself, the other headers and the body stay private.
 */
fn main(
    header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>,
    pubkey: pub RSAPubkey<KEY_LIMBS_2048>,
    signature: [Field; KEY_LIMBS_2048],
    from_header_sequence: Sequence,
    from_address_sequence: Sequence,
    subject_sequence: Sequence,
    salt: pub Field,
) -> pub (Field, BoundedVec<u8, MAX_DOMAIN_LENGTH>, BoundedVec<u8, MAX_SUBJECT_LENGTH>) {
    assert(header.len() <= MAX_EMAIL_HEADER_LENGTH);
    pubkey.verify_dkim_signature(header, signature);

    let from = comptime { "from".as_bytes() };
    let address = get_email_address(header, from_header_sequence, from_address_sequence, from);

    // Lowercase the address; find the last '@'.
    let mut lowered: [Field; MAX_EMAIL_ADDRESS_LENGTH] = [0; MAX_EMAIL_ADDRESS_LENGTH];
    let mut at: u32 = 0;
    let mut found = false;
    for i in 0..MAX_EMAIL_ADDRESS_LENGTH {
        if i < address.len() {
            let c = address.get_unchecked(i);
            let l = if (c >= 65) & (c <= 90) { c + 32 } else { c };
            lowered[i] = l as Field;
            if c == 64 {
                at = i;
                found = true;
            }
        }
    }
    assert(found & (at > 0) & (at + 1 < address.len()), "The sender address has no domain");
    // Hash the lowercased address packed 31 bytes per field (cheap), its length and the
    // enrollment's salt, so a published hash cannot be checked against a list of addresses
    // without redoing the work for each enrollment.
    let mut packed: [Field; 13] = [0; 13];
    for i in 0..MAX_EMAIL_ADDRESS_LENGTH {
        if i < address.len() {
            let slot = i / 31;
            packed[slot] = packed[slot] * 256 + lowered[i];
        }
    }
    packed[11] = address.len() as Field;
    packed[12] = salt;
    let address_hash = pedersen_hash(packed);

    let mut domain: BoundedVec<u8, MAX_DOMAIN_LENGTH> = BoundedVec::new();
    assert(address.len() - at - 1 <= MAX_DOMAIN_LENGTH, "The sender domain is too long");
    for i in 0..MAX_DOMAIN_LENGTH {
        let index = at + 1 + i;
        if index < address.len() {
            domain.push(lowered[index] as u8);
        }
    }

    // The subject field, uninterrupted; its value after "subject:".
    let subject_name = comptime { "subject".as_bytes() };
    constrain_header_field::<MAX_EMAIL_HEADER_LENGTH, MAX_SUBJECT_LENGTH + 8, 7>(header, subject_sequence, subject_name);
    let mut subject: BoundedVec<u8, MAX_SUBJECT_LENGTH> = BoundedVec::new();
    let start = subject_sequence.index + 8;
    for i in 0..MAX_SUBJECT_LENGTH {
        let index = start + i;
        if index < subject_sequence.end_index() {
            subject.push(header.get_unchecked(index));
        }
    }

    (address_hash, domain, subject)
}
