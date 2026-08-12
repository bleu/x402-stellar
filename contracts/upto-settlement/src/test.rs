#![cfg(test)]
extern crate std;

use super::{Error, UptoSettlement, UptoSettlementClient};
use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    token, Address, BytesN, Env, IntoVal, Symbol,
};

struct Fixture<'a> {
    env: Env,
    client: UptoSettlementClient<'a>,
    token: Address,
    buyer: Address,
    merchant: Address,
    salt: BytesN<32>,
}

fn setup(buyer_balance: i128) -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(1_000);

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = sac.address();

    let buyer = Address::generate(&env);
    let merchant = Address::generate(&env);

    let asset_admin = token::StellarAssetClient::new(&env, &token);
    asset_admin.mint(&buyer, &buyer_balance);

    let contract_id = env.register(UptoSettlement, ());
    let client = UptoSettlementClient::new(&env, &contract_id);

    let salt = BytesN::from_array(&env, &[7u8; 32]);
    Fixture {
        env,
        client,
        token,
        buyer,
        merchant,
        salt,
    }
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    token::TokenClient::new(env, token).balance(who)
}

#[test]
fn settles_actual_below_cap_and_leaves_remainder_with_buyer() {
    let f = setup(1_000);
    let settled = f.client.settle(
        &f.buyer,
        &f.merchant,
        &f.token,
        &1_000, // cap
        &0,     // valid_after_ledger
        &2_000, // deadline_ledger
        &5_000, // expiration_ledger
        &f.salt,
        &300, // actual
    );

    assert_eq!(settled, 300);
    assert_eq!(balance(&f.env, &f.token, &f.merchant), 300);
    // Remainder stays with the buyer — nothing parked in the contract.
    assert_eq!(balance(&f.env, &f.token, &f.buyer), 700);
}

#[test]
fn rejects_amount_above_cap() {
    let f = setup(1_000);
    let res = f.client.try_settle(
        &f.buyer, &f.merchant, &f.token, &1_000, &0, &2_000, &5_000, &f.salt, &1_001,
    );
    assert_eq!(res, Err(Ok(Error::AmountExceedsMaximum)));
    assert_eq!(balance(&f.env, &f.token, &f.merchant), 0);
}

#[test]
fn rejects_negative_amount() {
    let f = setup(1_000);
    let res = f.client.try_settle(
        &f.buyer, &f.merchant, &f.token, &1_000, &0, &2_000, &5_000, &f.salt, &-1,
    );
    assert_eq!(res, Err(Ok(Error::AmountNegative)));
}

#[test]
fn rejects_before_valid_after() {
    let f = setup(1_000);
    let res = f.client.try_settle(
        &f.buyer, &f.merchant, &f.token, &1_000, &1_500, &2_000, &5_000, &f.salt, &300,
    );
    assert_eq!(res, Err(Ok(Error::NotYetValid)));
}

#[test]
fn rejects_after_deadline() {
    let f = setup(1_000);
    f.env.ledger().set_sequence_number(3_000);
    let res = f.client.try_settle(
        &f.buyer, &f.merchant, &f.token, &1_000, &0, &2_000, &5_000, &f.salt, &300,
    );
    assert_eq!(res, Err(Ok(Error::Expired)));
}

#[test]
fn full_cap_settlement_pays_exactly_the_cap() {
    let f = setup(1_000);
    let settled = f.client.settle(
        &f.buyer, &f.merchant, &f.token, &1_000, &0, &2_000, &5_000, &f.salt, &1_000,
    );
    assert_eq!(settled, 1_000);
    assert_eq!(balance(&f.env, &f.token, &f.merchant), 1_000);
    assert_eq!(balance(&f.env, &f.token, &f.buyer), 0);
}

// The buyer's authorization must cover every argument except the amount, with
// the nested approve as its only sub-invocation. This pins the signed tuple's
// contents and order, so dropping or reordering a field breaks this test.
// Single-use of the signed entry is protocol-level (auth-entry nonce) and is
// not observable in unit tests; it was proven on testnet (STE-60).
#[test]
fn buyer_authorization_binds_everything_except_amount() {
    let f = setup(1_000);
    f.client.settle(
        &f.buyer, &f.merchant, &f.token, &1_000, &0, &2_000, &5_000, &f.salt, &300,
    );

    let expected = AuthorizedInvocation {
        function: AuthorizedFunction::Contract((
            f.client.address.clone(),
            Symbol::new(&f.env, "settle"),
            (
                f.merchant.clone(),
                f.token.clone(),
                1_000_i128,
                0_u32,
                2_000_u32,
                5_000_u32,
                f.salt.clone(),
            )
                .into_val(&f.env),
        )),
        sub_invocations: std::vec![AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                f.token.clone(),
                Symbol::new(&f.env, "approve"),
                (
                    f.buyer.clone(),
                    f.client.address.clone(),
                    1_000_i128,
                    5_000_u32,
                )
                    .into_val(&f.env),
            )),
            sub_invocations: std::vec![],
        }],
    };
    assert_eq!(f.env.auths(), std::vec![(f.buyer.clone(), expected)]);
}

// An authorization signed for the merchant must not settle to another
// recipient: pay_to is inside the signed args, so redirection fails auth.
#[test]
fn rejects_recipient_not_covered_by_the_authorization() {
    let f = setup(1_000);
    let attacker = Address::generate(&f.env);

    f.env.mock_auths(&[MockAuth {
        address: &f.buyer,
        invoke: &MockAuthInvoke {
            contract: &f.client.address,
            fn_name: "settle",
            args: (
                f.merchant.clone(),
                f.token.clone(),
                1_000_i128,
                0_u32,
                2_000_u32,
                5_000_u32,
                f.salt.clone(),
            )
                .into_val(&f.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &f.token,
                fn_name: "approve",
                args: (
                    f.buyer.clone(),
                    f.client.address.clone(),
                    1_000_i128,
                    5_000_u32,
                )
                    .into_val(&f.env),
                sub_invokes: &[],
            }],
        },
    }]);

    let res = f.client.try_settle(
        &f.buyer, &attacker, &f.token, &1_000, &0, &2_000, &5_000, &f.salt, &300,
    );
    assert!(res.is_err());
    assert_eq!(balance(&f.env, &f.token, &attacker), 0);
    assert_eq!(balance(&f.env, &f.token, &f.buyer), 1_000);
}
