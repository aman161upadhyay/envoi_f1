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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Spend {
    vaults: LookupMap<AccountId, u128>,
    policies: LookupMap<AccountId, Policy>,
    spent: LookupMap<AccountId, (u64, u128)>,
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
    pub fn register_agent(&mut self, agent: AccountId) {
        require!(env::attached_deposit().as_yoctonear() == 1, "owner must attach one yoctoNEAR");
        require!(!self.policies.contains_key(&agent), "agent already registered");
        self.policies.insert(agent, Policy {
            owner: env::predecessor_account_id(),
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

    pub fn pay(&mut self, to: AccountId, amount: U128, case_ref: String, expected_policy_hash: Option<String>) -> PromiseOrValue<Value> {
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
        if let Some(expected) = expected_policy_hash {
            require!(expected == policy_ref.policy_hash, "stale policy hash");
        }
        if policy_ref.paused { return refuse("paused"); }
        let Some(payee) = policy_ref.payees.iter().find(|entry| entry.account == to) else { return refuse("not_payee"); };
        if amount.0 > payee.max_per_payment.0 { return refuse("over_max"); }
        if amount.0 > policy_ref.daily_cap.0.saturating_sub(spent) { return refuse("over_daily_cap"); }
        let balance = self.vault_of(policy_ref.owner.clone()).0;
        if amount.0 > balance { return refuse("vault_low"); }

        self.vaults.insert(policy_ref.owner.clone(), balance - amount.0);
        self.spent.insert(agent.clone(), (day, spent + amount.0));
        let transfer = Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount.0));
        let payment = Payment { agent, owner: policy_ref.owner.clone(), to, amount, case_ref, day,
            policy_hash: policy_ref.policy_hash.clone() };
        PromiseOrValue::Promise(transfer.then(Self::ext(env::current_account_id())
            .with_static_gas(Gas::from_tgas(15)).on_paid(payment)))
    }

    #[private]
    pub fn on_paid(&mut self, payment: Payment, #[callback_result] result: Result<(), PromiseError>) -> Value {
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
