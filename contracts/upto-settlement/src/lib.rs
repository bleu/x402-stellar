#![no_std]

//! Minimal `upto` settlement contract for Stellar (STE-60, experiment 2b).
//!
//! Allowance-proxy shape: the buyer signs a settlement authorization over
//! everything except the actual amount. The contract grants itself the buyer's
//! allowance up to the cap and pulls only the actual amount to the bound
//! recipient. No funds are ever parked in the contract, so there is no refund
//! path — an unused allowance simply expires.
//!
//! Replay protection is inherited from Soroban: the auth entry carries its own
//! nonce, consumed on first use, so the contract keeps no nonce storage. The
//! `salt` field only lets a buyer sign two otherwise-identical authorizations.
//!
//! Aligns with the emerging upstream draft `scheme_upto_stellar.md`
//! (x402-foundation/x402 PR #3134). Not audited; testnet experiment only.

use soroban_sdk::{contract, contracterror, contractimpl, token, Address, BytesN, Env, IntoVal};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AmountNegative = 1,
    AmountExceedsMaximum = 2,
    NotYetValid = 3,
    Expired = 4,
}

#[contract]
pub struct UptoSettlement;

#[contractimpl]
impl UptoSettlement {
    /// Settle an `upto` payment.
    ///
    /// The buyer authorizes every argument except `amount`. The facilitator
    /// supplies the actual `amount` at call time; it must satisfy
    /// `0 <= amount <= max_amount`. Returns the settled amount.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        env: Env,
        from: Address,
        pay_to: Address,
        asset: Address,
        max_amount: i128,
        valid_after_ledger: u32,
        deadline_ledger: u32,
        expiration_ledger: u32,
        salt: BytesN<32>,
        amount: i128,
    ) -> Result<i128, Error> {
        // The buyer's signature binds everything but the amount. Because this
        // is require_auth_for_args (not require_auth), amount stays out of the
        // signed payload and the facilitator chooses it here.
        from.require_auth_for_args(
            (
                pay_to.clone(),
                asset.clone(),
                max_amount,
                valid_after_ledger,
                deadline_ledger,
                expiration_ledger,
                salt,
            )
                .into_val(&env),
        );

        if amount < 0 {
            return Err(Error::AmountNegative);
        }
        if amount > max_amount {
            return Err(Error::AmountExceedsMaximum);
        }

        let ledger = env.ledger().sequence();
        if ledger < valid_after_ledger {
            return Err(Error::NotYetValid);
        }
        if ledger > deadline_ledger {
            return Err(Error::Expired);
        }

        let this = env.current_contract_address();
        let token = token::TokenClient::new(&env, &asset);

        // Grant this contract the buyer's allowance up to the cap, authorized
        // by the same signed auth entry as a sub-invocation, then pull only the
        // actual amount to the bound recipient. Nothing is parked here.
        token.approve(&from, &this, &max_amount, &expiration_ledger);
        token.transfer_from(&this, &from, &pay_to, &amount);

        Ok(amount)
    }
}

mod test;
