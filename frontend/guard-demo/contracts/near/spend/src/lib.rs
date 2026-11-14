use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};
use std::collections::BTreeSet;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Payee {
    account: AccountId,
    max_per_payment: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    owner: AccountId,
    payees: Vec<Payee>,
    daily_cap: U128,
    paused: bool,
    policy_hash: String,
    version: u32,
}

#[near(serializers = [json])]
pub struct Payment {
    agent: AccountId,
    owner: AccountId,
    to: AccountId,
    amount: U128,
    case_ref: String,
    day: u64,
    policy_hash: String,
}

#[near(serializers = [json])]
pub struct PaymentApproval {
    expires_at_ms: u64,
    signature: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Spend {
    vaults: LookupMap<AccountId, u128>,
    policies: LookupMap<AccountId, Policy>,
    spent: LookupMap<AccountId, (u64, u128)>,
}

// Keep approvals in a separate storage prefix so existing vaults and policies need no migration.
fn registration_approvals() -> LookupMap<AccountId, AccountId> {
    LookupMap::new(b"a")
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq)]
enum PaymentStatus {
    Pending,
    Paid,
    Cancelled,
    PendingCancelled,
}

fn payment_references() -> LookupMap<[u8; 32], PaymentStatus> {
    LookupMap::new(b"r")
}

fn approval_keys() -> LookupMap<AccountId, [u8; 32]> {
    LookupMap::new(b"k")
}

fn decode_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 || !value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut decoded = [0; N];
    for (index, byte) in decoded.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(decoded)
}

fn payment_reference(agent: &AccountId, case_ref: &str) -> [u8; 32] {
    // Account IDs cannot contain NUL, so the account and reference have an unambiguous boundary.
    env::sha256_array(format!("{agent}\0{case_ref}").as_bytes())
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({
        "standard": "envoi_spend", "version": "1.0.0", "event": event, "data": [data]
    })));
}

#[near]
impl Spend {
    #[init]
    pub fn new() -> Self {
        Self { vaults: LookupMap::new(b"v"), policies: LookupMap::new(b"p"), spent: LookupMap::new(b"s") }
    }

    #[payable]
    pub fn deposit(&mut self) {
        let owner = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "positive deposit required");
        self.credit(&owner, amount);
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        require!(env::attached_deposit().as_yoctonear() == 1, "owner must attach one yoctoNEAR");
        let owner = env::predecessor_account_id();
        let balance = self.vault_of(owner.clone()).0;
        require!(amount.0 > 0 && amount.0 <= balance, "invalid withdrawal");
        self.vaults.insert(owner.clone(), balance - amount.0);
        Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).on_withdraw(owner, amount))
    }

    #[private]
    pub fn on_withdraw(&mut self, owner: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.credit(&owner, amount.0);
        }
    }

    #[payable]
    pub fn approve_registration(&mut self, owner: Option<AccountId>) {
        require!(env::attached_deposit().as_yoctonear() == 1, "agent must attach one yoctoNEAR");
        let agent = env::predecessor_account_id();
        require!(!self.policies.contains_key(&agent), "agent already registered");
        let mut approvals = registration_approvals();
        if let Some(owner) = owner {
            approvals.insert(agent, owner);
        } else {
            approvals.remove(&agent);
        }
    }

    #[payable]
    pub fn register_agent(&mut self, agent: AccountId) {
        require!(env::attached_deposit().as_yoctonear() == 1, "owner must attach one yoctoNEAR");
        require!(!self.policies.contains_key(&agent), "agent already registered");
        let owner = env::predecessor_account_id();
        let mut approvals = registration_approvals();
        require!(approvals.get(&agent) == Some(&owner), "agent approval required");
        approvals.remove(&agent);
        self.policies.insert(agent, Policy {
            owner,
            payees: vec![],
            daily_cap: U128(0),
            paused: false,
            policy_hash: "0".repeat(64),
            version: 0,
        });
    }

    pub fn set_policy(&mut self, agent: AccountId, payees: Vec<Payee>, daily_cap: U128, policy_hash: String, expected_version: u32) {
        let mut current = self.owned_policy(&agent);
        require!(current.version == expected_version, "stale policy version");
        require!(payees.len() <= 32, "too many payees");
        require!(policy_hash.len() == 64 && policy_hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')), "invalid policy hash");
        let mut accounts = BTreeSet::new();
        for payee in &payees {
            require!(accounts.insert(&payee.account), "duplicate payee");
            require!(payee.max_per_payment.0 > 0 && payee.max_per_payment.0 <= daily_cap.0, "invalid payee cap");
        }
        current.version += 1;
        current.payees = payees;
        current.daily_cap = daily_cap;
        current.policy_hash = policy_hash;
        emit("policy_set", json!({ "agent": agent, "policy": &current }));
        self.policies.insert(agent, current);
    }

    pub fn pause(&mut self, agent: AccountId) { self.set_paused(agent, true); }

    pub fn resume(&mut self, agent: AccountId) { self.set_paused(agent, false); }

    #[payable]
    pub fn set_payment_approval_key(&mut self, agent: AccountId, public_key: Option<String>) {
        require!(env::attached_deposit().as_yoctonear() == 1, "owner must attach one yoctoNEAR");
        self.owned_policy(&agent);
        let mut keys = approval_keys();
        if let Some(public_key) = public_key {
            let key = decode_hex(&public_key).unwrap_or_else(|| env::panic_str("invalid approval key"));
            keys.insert(agent, key);
        } else {
            keys.remove(&agent);
        }
    }

    pub fn get_payment_approval_key(&self, agent: AccountId) -> Option<String> {
        approval_keys().get(&agent).map(|key| key.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn payment_cancellation_supported(&self) -> bool { true }

    pub fn cancel_payments(&mut self, agent: AccountId, case_refs: Vec<String>, signature: String) {
        require!(!case_refs.is_empty() && case_refs.len() <= 32 &&
            case_refs.iter().all(|reference| !reference.is_empty() && reference.len() <= 128), "invalid payment references");
        let owner = self.get_policy(agent.clone()).unwrap_or_else(|| env::panic_str("unknown agent")).owner;
        let approval_key = approval_keys().get(&agent).copied()
            .unwrap_or_else(|| env::panic_str("payment approval key missing"));
        let signature = decode_hex(&signature).unwrap_or_else(|| env::panic_str("invalid cancellation signature"));
        let digest = cancellation_digest(&owner, &agent, &case_refs);
        require!(env::ed25519_verify(&signature, &digest, &approval_key), "invalid cancellation signature");

        let mut references = payment_references();
        for case_ref in case_refs {
            let reference = payment_reference(&agent, &case_ref);
            match references.get(&reference) {
                None => { references.insert(reference, PaymentStatus::Cancelled); }
                Some(PaymentStatus::Pending) => { references.insert(reference, PaymentStatus::PendingCancelled); }
                _ => {}
            }
        }
    }

    pub fn pay(&mut self, to: AccountId, amount: U128, case_ref: String, expected_policy_hash: Option<String>,
        approval: Option<PaymentApproval>) -> PromiseOrValue<Value> {
        require!(amount.0 > 0 && !case_ref.is_empty() && case_ref.len() <= 128, "invalid payment");
        let agent = env::predecessor_account_id();
        let policy = self.get_policy(agent.clone());
        let day = env::block_timestamp_ms() / 86_400_000;
        let spent = self.spent.get(&agent).filter(|entry| entry.0 == day).map_or(0, |entry| entry.1);
        let refuse = |reason: &str| {
            let data = json!({ "agent": agent, "to": to, "amount": amount, "case_ref": case_ref,
                "status": "refused", "reason": reason, "policy_hash": policy.as_ref().map(|p| &p.policy_hash) });
            emit("pay_refused", data.clone());
            PromiseOrValue::Value(data)
        };
        let Some(policy_ref) = &policy else { return refuse("not_registered"); };
        let reference = payment_reference(&agent, &case_ref);
        let mut references = payment_references();
        // A duplicate transaction must not look like a final outcome for the original payment.
        match references.get(&reference) {
            Some(PaymentStatus::Cancelled | PaymentStatus::PendingCancelled) => env::panic_str("payment approval cancelled"),
            Some(PaymentStatus::Pending | PaymentStatus::Paid) => env::panic_str("duplicate payment reference"),
            None => {}
        }
        if let Some(expected) = expected_policy_hash {
            require!(expected == policy_ref.policy_hash, "stale policy hash");
        }
        if policy_ref.paused { return refuse("paused"); }
        let Some(payee) = policy_ref.payees.iter().find(|entry| entry.account == to) else { return refuse("not_payee"); };
        if amount.0 > payee.max_per_payment.0 { return refuse("over_max"); }
        if amount.0 > policy_ref.daily_cap.0.saturating_sub(spent) { return refuse("over_daily_cap"); }
        let balance = self.vault_of(policy_ref.owner.clone()).0;
        if amount.0 > balance { return refuse("vault_low"); }

        let approval = approval.unwrap_or_else(|| env::panic_str("payment approval required"));
        require!(env::block_timestamp_ms() < approval.expires_at_ms, "payment approval expired");
        let key = approval_keys().get(&agent).copied().unwrap_or_else(|| env::panic_str("payment approval key missing"));
        let signature = decode_hex(&approval.signature).unwrap_or_else(|| env::panic_str("invalid payment approval signature"));
        let payment = Payment { agent, owner: policy_ref.owner.clone(), to, amount, case_ref, day,
            policy_hash: policy_ref.policy_hash.clone() };
        let digest = approval_digest(&payment, policy_ref.version, approval.expires_at_ms);
        require!(env::ed25519_verify(&signature, &digest, &key), "invalid payment approval signature");

        references.insert(reference, PaymentStatus::Pending);
        self.vaults.insert(policy_ref.owner.clone(), balance - amount.0);
        self.spent.insert(payment.agent.clone(), (day, spent + amount.0));
        let transfer = Promise::new(payment.to.clone()).transfer(NearToken::from_yoctonear(amount.0));
        PromiseOrValue::Promise(transfer.then(Self::ext(env::current_account_id())
            .with_static_gas(Gas::from_tgas(15)).on_reserved_payment(payment)))
    }

    #[private]
    pub fn on_reserved_payment(&mut self, payment: Payment, #[callback_result] result: Result<(), PromiseError>) -> Value {
        let reference = payment_reference(&payment.agent, &payment.case_ref);
        let mut references = payment_references();
        let cancelled = match references.get(&reference) {
            Some(PaymentStatus::Pending) => false,
            Some(PaymentStatus::PendingCancelled) => true,
            _ => env::panic_str("payment is not pending"),
        };
        if result.is_ok() {
            references.insert(reference, PaymentStatus::Paid);
        } else if cancelled {
            references.insert(reference, PaymentStatus::Cancelled);
        } else {
            references.remove(&reference);
        }
        self.complete_payment(payment, result)
    }

    // Earlier deployments scheduled this callback without a reference reservation.
    #[private]
    pub fn on_paid(&mut self, payment: Payment, #[callback_result] result: Result<(), PromiseError>) -> Value {
        self.complete_payment(payment, result)
    }

    fn complete_payment(&mut self, payment: Payment, result: Result<(), PromiseError>) -> Value {
        let event = if result.is_ok() { "paid" } else {
            self.credit(&payment.owner, payment.amount.0);
            if let Some((day, amount)) = self.spent.get(&payment.agent).copied() {
                if day == payment.day {
                    self.spent.insert(payment.agent.clone(), (day, amount - payment.amount.0));
                }
            }
            "pay_failed"
        };
        let data = json!({ "status": if event == "paid" { "paid" } else { "failed" },
            "agent": payment.agent, "to": payment.to, "amount": payment.amount, "case_ref": payment.case_ref,
            "policy_hash": payment.policy_hash });
        emit(event, data.clone());
        data
    }

    pub fn get_policy(&self, agent: AccountId) -> Option<Policy> { self.policies.get(&agent).cloned() }

    pub fn vault_of(&self, owner: AccountId) -> U128 { U128(self.vaults.get(&owner).copied().unwrap_or(0)) }

    fn credit(&mut self, owner: &AccountId, amount: u128) {
        let balance = self.vault_of(owner.clone()).0;
        self.vaults.insert(owner.clone(), balance + amount);
    }

    fn owned_policy(&self, agent: &AccountId) -> Policy {
        let policy = self.get_policy(agent.clone()).unwrap_or_else(|| env::panic_str("unknown agent"));
        require!(policy.owner == env::predecessor_account_id(), "owner required");
        policy
    }

    fn set_paused(&mut self, agent: AccountId, paused: bool) {
        let mut policy = self.owned_policy(&agent);
        policy.paused = paused;
        emit(if paused { "agent_paused" } else { "agent_resumed" }, json!({ "agent": agent }));
        self.policies.insert(agent, policy);
    }
}

fn approval_digest(payment: &Payment, version: u32, expires_at_ms: u64) -> [u8; 32] {
    env::sha256_array(json!(["envoi.near.payment/v1", env::current_account_id(), payment.owner,
        payment.agent, payment.to, payment.amount, payment.case_ref, payment.policy_hash,
        version, expires_at_ms]).to_string().as_bytes())
}

fn cancellation_digest(owner: &AccountId, agent: &AccountId, case_refs: &[String]) -> [u8; 32] {
    env::sha256_array(json!(["envoi.near.payment.cancel/v1", env::current_account_id(),
        owner, agent, case_refs]).to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn call(who: usize) {
        context(who, 1, 0);
    }

    fn context(who: usize, deposit: u128, day: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(day * 86_400_000_000_000)
            .build());
    }

    fn funded_contract() -> Spend {
        call(1);
        let mut contract = Spend::new();
        contract.approve_registration(Some(accounts(0)));
        call(2);
        contract.approve_registration(Some(accounts(0)));
        call(0);
        let payees = vec![Payee { account: accounts(3), max_per_payment: U128(3) }];
        for agent in [accounts(1), accounts(2)] {
            contract.register_agent(agent.clone());
            contract.set_policy(agent.clone(), payees.clone(), U128(10), "a".repeat(64), 0);
            set_approval_key(&mut contract, agent);
        }
        context(0, 10, 0);
        contract.deposit();
        contract
    }

    fn as_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn signer() -> SigningKey {
        SigningKey::from_bytes(&[7; 32])
    }

    fn set_approval_key(contract: &mut Spend, agent: AccountId) {
        contract.set_payment_approval_key(agent, Some(as_hex(signer().verifying_key().as_bytes())));
    }

    fn approve(payment: &Payment, version: u32, expires_at_ms: u64) -> PaymentApproval {
        let signature = signer().sign(&approval_digest(payment, version, expires_at_ms));
        PaymentApproval { expires_at_ms, signature: as_hex(&signature.to_bytes()) }
    }

    fn payment() -> Payment {
        Payment { agent: accounts(1), owner: accounts(0), to: accounts(3), amount: U128(3),
            case_ref: "payment-1".into(), day: 0, policy_hash: "a".repeat(64) }
    }

    fn pay_once(contract: &mut Spend, agent: usize, day: u64) {
        context(agent, 0, day);
        let payment = Payment { agent: accounts(agent), ..payment() };
        let approval = approve(&payment, 1, day * 86_400_000 + 1000);
        assert!(matches!(contract.pay(accounts(3), U128(3), "payment-1".into(), Some("a".repeat(64)), Some(approval)),
            PromiseOrValue::Promise(_)));
    }

    fn cancel_reference(contract: &mut Spend) {
        context(5, 0, 0);
        let references = vec![payment().case_ref];
        let signature = signer().sign(&cancellation_digest(&accounts(0), &accounts(1), &references));
        contract.cancel_payments(accounts(1), references, as_hex(&signature.to_bytes()));
    }

    #[test]
    #[should_panic(expected = "payment approval cancelled")]
    fn cancelled_reference_cannot_debit_the_vault() {
        let mut contract = funded_contract();
        cancel_reference(&mut contract);
        cancel_reference(&mut contract);
        assert_eq!(contract.vault_of(accounts(0)).0, 10);
        pay_once(&mut contract, 1, 0);
    }

    #[test]
    #[should_panic(expected = "invalid cancellation signature")]
    fn relay_cannot_change_the_signed_reference() {
        let mut contract = funded_contract();
        let signature = signer().sign(&cancellation_digest(&accounts(0), &accounts(1), &[payment().case_ref]));
        contract.cancel_payments(accounts(1), vec!["another-payment".into()], as_hex(&signature.to_bytes()));
    }

    #[test]
    fn payment_reserved_before_cancellation_can_settle_once() {
        let mut contract = funded_contract();
        pay_once(&mut contract, 1, 0);
        cancel_reference(&mut contract);
        assert_eq!(contract.on_reserved_payment(payment(), Ok(()))["status"], "paid");
        cancel_reference(&mut contract);
        assert_eq!(contract.vault_of(accounts(0)).0, 7);
        assert!(payment_references().get(&payment_reference(&accounts(1), &payment().case_ref)) == Some(&PaymentStatus::Paid));
    }

    #[test]
    fn cancellation_prevents_retry_if_the_pending_transfer_is_refunded() {
        let mut contract = funded_contract();
        pay_once(&mut contract, 1, 0);
        cancel_reference(&mut contract);
        assert_eq!(contract.on_reserved_payment(payment(), Err(PromiseError::Failed))["status"], "failed");
        assert_eq!(contract.vault_of(accounts(0)).0, 10);
        assert!(payment_references().get(&payment_reference(&accounts(1), &payment().case_ref)) == Some(&PaymentStatus::Cancelled));
    }

    #[test]
    #[should_panic(expected = "payment approval required")]
    fn a_pay_only_key_cannot_bypass_exact_approval() {
        let mut contract = funded_contract();
        context(1, 0, 0);
        contract.pay(accounts(3), U128(3), "payment-1".into(), None, None);
    }

    #[test]
    #[should_panic(expected = "payment approval expired")]
    fn rejects_approval_at_the_expiry_boundary() {
        let mut contract = funded_contract();
        context(1, 0, 1);
        let approval = approve(&payment(), 1, 86_400_000);
        contract.pay(accounts(3), U128(3), "payment-1".into(), None, Some(approval));
    }

    #[test]
    #[should_panic(expected = "invalid payment approval signature")]
    fn rejects_change_to_an_approved_amount_within_the_cap() {
        let mut contract = funded_contract();
        context(1, 0, 0);
        let approval = approve(&payment(), 1, 1000);
        contract.pay(accounts(3), U128(2), "payment-1".into(), None, Some(approval));
    }

    #[test]
    #[should_panic(expected = "invalid payment approval signature")]
    fn rejects_approval_after_rotation_even_if_the_policy_hash_matches() {
        let mut contract = funded_contract();
        context(1, 0, 0);
        let approval = approve(&payment(), 1, 1000);
        call(0);
        let policy = contract.get_policy(accounts(1)).unwrap();
        contract.set_policy(accounts(1), policy.payees, policy.daily_cap, policy.policy_hash, policy.version);
        context(1, 0, 0);
        contract.pay(accounts(3), U128(3), "payment-1".into(), None, Some(approval));
    }

    #[test]
    #[should_panic(expected = "duplicate payment reference")]
    fn rejects_duplicate_before_the_transfer_callback() {
        let mut contract = funded_contract();
        pay_once(&mut contract, 1, 0);
        assert_eq!(contract.vault_of(accounts(0)).0, 7);
        pay_once(&mut contract, 1, 0);
    }

    #[test]
    #[should_panic(expected = "duplicate payment reference")]
    fn rejects_duplicate_after_settlement_even_on_a_new_day() {
        let mut contract = funded_contract();
        pay_once(&mut contract, 1, 0);
        assert_eq!(contract.on_reserved_payment(payment(), Ok(()))["status"], "paid");
        assert_eq!(contract.vault_of(accounts(0)).0, 7);
        pay_once(&mut contract, 1, 1);
    }

    #[test]
    fn failure_refunds_both_limits_and_allows_same_reference_to_retry() {
        let mut contract = funded_contract();
        pay_once(&mut contract, 1, 0);
        assert_eq!(contract.on_reserved_payment(payment(), Err(PromiseError::Failed))["status"], "failed");
        assert_eq!(contract.vault_of(accounts(0)).0, 10);
        assert_eq!(contract.spent.get(&accounts(1)), Some(&(0, 0)));
        pay_once(&mut contract, 1, 0);
        assert_eq!(contract.on_reserved_payment(payment(), Ok(()))["status"], "paid");
        assert_eq!(contract.vault_of(accounts(0)).0, 7);
        assert_eq!(contract.spent.get(&accounts(1)), Some(&(0, 3)));
    }

    #[test]
    fn refusal_does_not_consume_a_reference_and_agents_are_independent() {
        let mut contract = funded_contract();
        context(1, 0, 0);
        let refusal = contract.pay(accounts(4), U128(3), "payment-1".into(), Some("a".repeat(64)), None);
        assert!(matches!(refusal, PromiseOrValue::Value(value) if value["reason"] == "not_payee"));
        pay_once(&mut contract, 1, 0);
        pay_once(&mut contract, 2, 0);
        assert_eq!(contract.vault_of(accounts(0)).0, 4);
    }

    #[test]
    fn a_legacy_in_flight_failure_still_restores_the_vault() {
        let mut contract = funded_contract();
        contract.vaults.insert(accounts(0), 7);
        contract.spent.insert(accounts(1), (0, 3));
        assert_eq!(contract.on_paid(payment(), Err(PromiseError::Failed))["status"], "failed");
        assert_eq!(contract.vault_of(accounts(0)).0, 10);
        assert_eq!(contract.spent.get(&accounts(1)), Some(&(0, 0)));
    }

    #[test]
    #[should_panic(expected = "agent approval required")]
    fn an_unapproved_owner_cannot_claim_an_agent() {
        call(0);
        let mut contract = Spend::new();
        contract.register_agent(accounts(1));
    }

    #[test]
    #[should_panic(expected = "agent approval required")]
    fn another_owner_cannot_use_the_agents_approval() {
        call(1);
        let mut contract = Spend::new();
        contract.approve_registration(Some(accounts(0)));
        call(2);
        contract.register_agent(accounts(1));
    }

    #[test]
    #[should_panic(expected = "agent approval required")]
    fn an_agent_can_cancel_its_approval_before_registration() {
        call(1);
        let mut contract = Spend::new();
        contract.approve_registration(Some(accounts(0)));
        contract.approve_registration(None);
        call(0);
        contract.register_agent(accounts(1));
    }

    #[test]
    fn approval_is_consumed_and_the_owners_vault_pays() {
        call(1);
        let mut contract = Spend::new();
        contract.approve_registration(Some(accounts(0)));
        call(0);
        contract.register_agent(accounts(1));
        assert_eq!(contract.get_policy(accounts(1)).unwrap().owner, accounts(0));
        assert!(!registration_approvals().contains_key(&accounts(1)));

        contract.deposit();
        let hash = "a".repeat(64);
        contract.set_policy(accounts(1), vec![Payee { account: accounts(2), max_per_payment: U128(1) }], U128(1), hash.clone(), 0);
        set_approval_key(&mut contract, accounts(1));
        call(1);
        let payment = Payment { to: accounts(2), amount: U128(1), case_ref: "demo-case".into(), ..payment() };
        let approval = approve(&payment, 1, 1000);
        assert!(matches!(contract.pay(accounts(2), U128(1), "demo-case".into(), Some(hash), Some(approval)), PromiseOrValue::Promise(_)));
        assert_eq!(contract.vault_of(accounts(0)).0, 0);
    }

    #[test]
    #[should_panic(expected = "agent already registered")]
    fn approval_cannot_replace_an_existing_policy() {
        call(1);
        let mut contract = Spend::new();
        // Simulate a policy loaded from the original deployment.
        contract.policies.insert(accounts(1), Policy {
            owner: accounts(0), payees: vec![], daily_cap: U128(0), paused: false,
            policy_hash: "0".repeat(64), version: 0,
        });
        contract.approve_registration(Some(accounts(2)));
    }
}
