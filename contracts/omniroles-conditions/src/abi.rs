//! Bounds-checked access to Solidity ABI-encoded data.
//!
//! Every read checks bounds and fails closed with
//! [`Status::CalldataOutOfBounds`]: a value the engine cannot locate is never
//! treated as passing.

use crate::tree::Layout;
use crate::types::Status;

pub type Word = [u8; 32];

const OUT: Status = Status::CalldataOutOfBounds;

/// The 32-byte word at `at`.
pub fn word(data: &[u8], at: usize) -> Result<&Word, Status> {
    let end = at.checked_add(32).ok_or(OUT)?;
    data.get(at..end).ok_or(OUT)?.try_into().map_err(|_| OUT)
}

/// A word used as an offset or a length: must fit comfortably in memory.
pub fn word_usize(data: &[u8], at: usize) -> Result<usize, Status> {
    let w = word(data, at)?;
    if w[..24].iter().any(|byte| *byte != 0) {
        return Err(OUT);
    }
    let value = u64::from_be_bytes(w[24..].try_into().expect("8 bytes"));
    usize::try_from(value).map_err(|_| OUT)
}

fn tail(data: &[u8], at: usize) -> Result<&[u8], Status> {
    data.get(at..).ok_or(OUT)
}

/// Content of a `bytes` / `string` value whose region starts with its length.
pub fn dynamic_bytes(region: &[u8]) -> Result<&[u8], Status> {
    let length = word_usize(region, 0)?;
    let end = 32usize.checked_add(length).ok_or(OUT)?;
    region.get(32..end).ok_or(OUT)
}

/// Region a node of `layout` reads, given the region its encoding starts at.
/// Nested ABI data is unwrapped from its `bytes` value and leading bytes.
fn enter<'a>(region: &'a [u8], layout: &Layout) -> Result<&'a [u8], Status> {
    match layout {
        Layout::AbiEncoded(_, leading) => tail(dynamic_bytes(region)?, *leading),
        _ => Ok(region),
    }
}

/// Region of each structural field of a tuple (or parameter list) at `base`.
pub fn tuple_fields<'a>(base: &'a [u8], fields: &[Layout]) -> Result<Vec<&'a [u8]>, Status> {
    let mut head = 0usize;
    let mut regions = Vec::with_capacity(fields.len());
    for field in fields {
        let region = if field.is_dynamic() {
            tail(base, word_usize(base, head)?)?
        } else {
            let region = tail(base, head)?;
            if region.len() < field.head_size() {
                return Err(OUT);
            }
            region
        };
        regions.push(enter(region, field)?);
        head = head.checked_add(field.head_size()).ok_or(OUT)?;
    }
    Ok(regions)
}

/// Region of each element of a dynamic array whose region starts with its length.
pub fn array_elements<'a>(region: &'a [u8], element: &Layout) -> Result<Vec<&'a [u8]>, Status> {
    let length = word_usize(region, 0)?;
    let items = tail(region, 32)?;
    let stride = element.head_size();
    // Each element occupies at least `stride` head bytes: bounds the loop by the data size.
    if stride == 0 || length.checked_mul(stride).ok_or(OUT)? > items.len() {
        return Err(OUT);
    }
    let mut regions = Vec::with_capacity(length);
    for index in 0..length {
        let head = index * stride;
        let region = if element.is_dynamic() {
            tail(items, word_usize(items, head)?)?
        } else {
            tail(items, head)?
        };
        regions.push(enter(region, element)?);
    }
    Ok(regions)
}

/// ABI word of an EVM address.
pub fn address_word(address: &[u8; 20]) -> Word {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

/// ABI word of an unsigned integer.
pub fn u128_word(value: u128) -> Word {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

/// The word as `u128`, if it fits.
pub fn word_u128(word: &Word) -> Option<u128> {
    if word[..16].iter().any(|byte| *byte != 0) {
        return None;
    }
    Some(u128::from_be_bytes(
        word[16..].try_into().expect("16 bytes"),
    ))
}
