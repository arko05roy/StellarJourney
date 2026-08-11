//! Deterministic identifier derivation (PLAN.md §10.2).
//!
//! `mandate_id = sha256(xdr_vec(network_id, contract_address, payer,
//! merchant, asset, client_nonce))`
//!
//! Binding the network id and this contract's own address into the preimage
//! means a mandate created on one network, or against one deployment of this
//! contract, can never collide with (or be replayed as) a mandate on another
//! network/deployment — the same logical inputs hash differently everywhere
//! else.
//!
//! The preimage is assembled as an explicit heterogeneous `Vec<Val>` rather
//! than a Rust tuple: `soroban-sdk` 27 gives tuples `IntoVal<Env, Vec<Val>>`
//! (see `soroban_sdk::tuple`), but `ToXdr` requires `IntoVal<Env, Val>`
//! directly, which `Vec<Val>` implements natively. Building the vector
//! ourselves also makes the exact field order — and therefore the hash
//! preimage — explicit at the call site instead of implicit in a tuple.
//!
//! `payment_id = sha256(xdr_vec(mandate_id, charge_id))`. A `charge_id` maps
//! 1:1 to a `payment_id`: the pair can only ever produce one successful
//! payment because `charge_id` is itself replay-guarded per mandate
//! (`storage::has_used_charge`), so deriving `payment_id` from
//! `(mandate_id, charge_id)` rather than storing a separate counter keeps
//! payment lookups deterministic without an extra sequence in storage.

use soroban_sdk::{xdr::ToXdr, Address, BytesN, Env, IntoVal, Val, Vec};

/// Derive the deterministic mandate id for a `create_mandate` call.
pub fn derive_mandate_id(
    env: &Env,
    payer: &Address,
    merchant: &Address,
    asset: &Address,
    client_nonce: &BytesN<32>,
) -> BytesN<32> {
    let network_id = env.ledger().network_id();
    let contract_address = env.current_contract_address();

    let mut preimage: Vec<Val> = Vec::new(env);
    preimage.push_back(network_id.into_val(env));
    preimage.push_back(contract_address.into_val(env));
    preimage.push_back(payer.into_val(env));
    preimage.push_back(merchant.into_val(env));
    preimage.push_back(asset.into_val(env));
    preimage.push_back(client_nonce.into_val(env));

    let bytes = preimage.to_xdr(env);
    env.crypto().sha256(&bytes).to_bytes()
}

/// Derive the deterministic payment id for a given mandate + charge id pair.
pub fn derive_payment_id(env: &Env, mandate_id: &BytesN<32>, charge_id: &BytesN<32>) -> BytesN<32> {
    let mut preimage: Vec<Val> = Vec::new(env);
    preimage.push_back(mandate_id.into_val(env));
    preimage.push_back(charge_id.into_val(env));

    let bytes = preimage.to_xdr(env);
    env.crypto().sha256(&bytes).to_bytes()
}
