use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct OwnerKey {
    key_type: String,
    public_key: String,
    label: String,
    registered_at_ms: u64,
    revoked_at_ms: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Batch {
    root: String,
    previous_root: String,
    count: u32,
    sealed_at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Record {
    publisher: AccountId,
    last_batch_id: u64,
    last_root: String,
    roots: LookupMap<u64, Batch>,
    keys: LookupMap<AccountId, Vec<OwnerKey>>,
}

fn is_hex32(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({
        "standard": "envoi_record", "version": "1.0.0", "event": event, "data": [data]
    })));
}

#[near]
impl Record {
    #[init]
    pub fn new(publisher: AccountId) -> Self {
        Self {
            publisher,
            last_batch_id: 0,
            last_root: "0".repeat(64),
            roots: LookupMap::new(b"r"),
            keys: LookupMap::new(b"k"),
        }
    }

    pub fn seal(&mut self, batch_id: u64, root: String, previous_root: String, count: u32) {
        require!(env::predecessor_account_id() == self.publisher, "not publisher");
        require!(batch_id == self.last_batch_id + 1, "out of order");
        require!(previous_root == self.last_root, "bad link");
        require!(is_hex32(&root) && count > 0, "invalid batch");
        let batch = Batch { root: root.clone(), previous_root, count, sealed_at_ms: env::block_timestamp_ms() };
        emit("sealed", json!({ "batch_id": batch_id, "batch": &batch }));
        self.roots.insert(batch_id, batch);
        self.last_batch_id = batch_id;
        self.last_root = root;
    }

    #[payable]
    pub fn register_owner_key(&mut self, key_type: String, public_key: String, label: String) {
        require!(key_type == "demo_device" && is_hex32(&public_key), "invalid key");
        require!(!label.trim().is_empty() && label.len() <= 64, "invalid label");
        let owner = env::predecessor_account_id();
        let mut keys = self.keys.get(&owner).cloned().unwrap_or_default();
        require!(keys.len() < 10, "key limit reached");
        require!(!keys.iter().any(|entry| entry.public_key == public_key), "duplicate key");
        let before = env::storage_usage();
        keys.push(OwnerKey {
            key_type,
            public_key: public_key.clone(),
            label,
            registered_at_ms: env::block_timestamp_ms(),
            revoked_at_ms: None,
        });
        self.keys.insert(owner.clone(), keys);
        self.keys.flush();
        // Reserve eight bytes for the eventual revocation timestamp.
        let bytes = env::storage_usage().saturating_sub(before) + 8;
        let cost = env::storage_byte_cost().as_yoctonear() * u128::from(bytes);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= cost, "storage deposit too low");
        if deposit > cost {
            let _ = Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(deposit - cost));
        }
        emit("owner_key_registered", json!({ "owner": owner, "public_key": public_key }));
    }

    pub fn revoke_owner_key(&mut self, public_key: String) {
        let owner = env::predecessor_account_id();
        let mut keys = self.keys.get(&owner).cloned().unwrap_or_default();
        let entry = keys.iter_mut().find(|entry| entry.public_key == public_key)
            .unwrap_or_else(|| env::panic_str("key not registered"));
        require!(entry.revoked_at_ms.is_none(), "already revoked");
        entry.revoked_at_ms = Some(env::block_timestamp_ms());
        self.keys.insert(owner.clone(), keys);
        emit("owner_key_revoked", json!({ "owner": owner, "public_key": public_key }));
    }

    pub fn root_of(&self, batch_id: u64) -> Option<Batch> {
        self.roots.get(&batch_id).cloned()
    }

    pub fn last(&self) -> (u64, String) {
        (self.last_batch_id, self.last_root.clone())
    }

    pub fn owner_keys(&self, owner: AccountId) -> Vec<OwnerKey> {
        self.keys.get(&owner).cloned().unwrap_or_default()
    }
}
