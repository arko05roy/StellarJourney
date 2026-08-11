//! Checked arithmetic helpers.
//!
//! Every arithmetic operation on money (`i128` base units) or time (`u64`
//! Unix seconds) must go through one of these helpers instead of a raw
//! operator. Overflow/underflow always maps to `Error::ArithmeticOverflow`
//! rather than a panic, so contract methods can return a typed error instead
//! of aborting the transaction with an opaque trap (CLAUDE.md §5, §9).

use crate::error::Error;

pub fn checked_add_i128(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}

pub fn checked_sub_i128(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_sub(b).ok_or(Error::ArithmeticOverflow)
}

pub fn checked_mul_i128(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_mul(b).ok_or(Error::ArithmeticOverflow)
}

pub fn checked_add_u64(a: u64, b: u64) -> Result<u64, Error> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}

pub fn checked_sub_u64(a: u64, b: u64) -> Result<u64, Error> {
    a.checked_sub(b).ok_or(Error::ArithmeticOverflow)
}

/// Added in Phase 3 for `successful_charges` (a `u32` counter).
pub fn checked_add_u32(a: u32, b: u32) -> Result<u32, Error> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}
