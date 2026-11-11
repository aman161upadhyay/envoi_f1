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

/// envoi's own evidence-signing key. Listing it here lets anyone check a proof's envoi
/// signature against NEAR instead of a key file envoi hands them.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EvidenceKey {
    public_key: String,
    registered_at_ms: u64,
    revoked_at_ms: Option<u64>,
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

// Evidence keys live under their own storage prefix rather than a new state field, so this
// version can replace the deployed code without migrating `Record`'s Borsh layout.
const EVIDENCE_PREFIX: &[u8] = b"e";
const MAX_OWNER_KEYS: usize = 10;

fn evidence_keys() -> LookupMap<String, EvidenceKey> {
    LookupMap::new(EVIDENCE_PREFIX)
}

fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_hex32(value: &str) -> bool {
    is_hex(value, 64)
}

/// An uncompressed SEC1 P-256 point (`04 || x || y`), the form WebCrypto exports for a passkey.
/// The curve check happens in the proof checker; the contract only enforces the shape.
fn is_p256_uncompressed(value: &str) -> bool {
    is_hex(value, 130) && value.starts_with("04")
}

/// The key types an owner can list, and the public key shape each one must have.
fn valid_owner_key(key_type: &str, public_key: &str) -> bool {
    match key_type {
        "demo_device" => is_hex32(public_key),
        "passkey" => is_p256_uncompressed(public_key),
        _ => false,
    }
}

fn valid_key_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
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

    /// An owner lists one of their own signing keys, from their own NEAR account. `key_type` is
    /// `demo_device` (Ed25519, 32-byte hex) or `passkey` (WebAuthn P-256, uncompressed 65-byte hex).
    #[payable]
    pub fn register_owner_key(&mut self, key_type: String, public_key: String, label: String) {
        require!(valid_owner_key(&key_type, &public_key), "invalid key");
        require!(!label.trim().is_empty() && label.len() <= 64, "invalid label");
        let owner = env::predecessor_account_id();
        let mut keys = self.keys.get(&owner).cloned().unwrap_or_default();
        require!(keys.len() < MAX_OWNER_KEYS, "key limit reached");
        require!(!keys.iter().any(|entry| entry.public_key == public_key), "duplicate key");
        let before = env::storage_usage();
        keys.push(OwnerKey {
            key_type: key_type.clone(),
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
        emit("owner_key_registered", json!({ "owner": owner, "key_type": key_type, "public_key": public_key }));
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

    /// The publisher lists one of envoi's Ed25519 evidence keys. A key ID is listed once and
    /// never reused, so an old proof can't be re-pointed at a newer key. Storage is paid from
    /// the contract balance because the publisher's scoped key can't attach a deposit.
    pub fn register_evidence_key(&mut self, key_id: String, public_key: String) {
        require!(env::predecessor_account_id() == self.publisher, "not publisher");
        require!(valid_key_id(&key_id), "invalid key id");
        require!(is_hex32(&public_key), "invalid key");
        let mut keys = evidence_keys();
        require!(!keys.contains_key(&key_id), "key id already used");
        keys.insert(key_id.clone(), EvidenceKey { public_key: public_key.clone(), registered_at_ms: env::block_timestamp_ms(), revoked_at_ms: None });
        keys.flush();
        emit("evidence_key_registered", json!({ "key_id": key_id, "public_key": public_key }));
    }

    /// Records created after revocation stop verifying; earlier ones still do.
    pub fn revoke_evidence_key(&mut self, key_id: String) {
        require!(env::predecessor_account_id() == self.publisher, "not publisher");
        let mut keys = evidence_keys();
        let mut entry = keys.get(&key_id).cloned().unwrap_or_else(|| env::panic_str("key not registered"));
        require!(entry.revoked_at_ms.is_none(), "already revoked");
        entry.revoked_at_ms = Some(env::block_timestamp_ms());
        keys.insert(key_id.clone(), entry);
        keys.flush();
        emit("evidence_key_revoked", json!({ "key_id": key_id }));
    }

    pub fn evidence_key(&self, key_id: String) -> Option<EvidenceKey> {
        evidence_keys().get(&key_id).cloned()
    }

    pub fn publisher(&self) -> AccountId {
        self.publisher.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const ED: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const R1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const R2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn p256() -> String {
        format!("04{}", "2".repeat(128))
    }

    fn zero() -> String {
        "0".repeat(64)
    }

    // Every call in these tests carries 0.1 NEAR so owner registrations can pay storage.
    fn call(who: usize, ms: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(who))
            .block_timestamp(ms * 1_000_000)
            .attached_deposit(NearToken::from_millinear(100))
            .build());
    }

    fn contract() -> Record {
        call(0, 1);
        Record::new(accounts(1))
    }

    #[test]
    fn seals_in_order_and_links_roots() {
        let mut c = contract();
        call(1, 10);
        c.seal(1, R1.into(), zero(), 2);
        call(1, 20);
        c.seal(2, R2.into(), R1.into(), 1);
        assert_eq!(c.last(), (2, R2.to_string()));
        let batch = c.root_of(2).unwrap();
        assert_eq!(batch.previous_root, R1);
        assert_eq!(batch.sealed_at_ms, 20);
        assert!(c.root_of(3).is_none());
    }

    #[test]
    #[should_panic(expected = "out of order")]
    fn rejects_skipped_batch() {
        let mut c = contract();
        call(1, 10);
        c.seal(2, R1.into(), zero(), 1);
    }

    #[test]
    #[should_panic(expected = "bad link")]
    fn rejects_broken_link() {
        let mut c = contract();
        call(1, 10);
        c.seal(1, R1.into(), zero(), 1);
        c.seal(2, R2.into(), zero(), 1);
    }

    #[test]
    #[should_panic(expected = "not publisher")]
    fn only_publisher_seals() {
        let mut c = contract();
        call(2, 10);
        c.seal(1, R1.into(), zero(), 1);
    }

    #[test]
    #[should_panic(expected = "invalid batch")]
    fn rejects_empty_batch() {
        let mut c = contract();
        call(1, 10);
        c.seal(1, R1.into(), zero(), 0);
    }

    #[test]
    fn owner_lists_demo_and_passkey_keys() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("demo_device".into(), ED.into(), "Demo device".into());
        c.register_owner_key("passkey".into(), p256(), "MacBook".into());
        let keys = c.owner_keys(accounts(3));
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[1].key_type, "passkey");
        assert_eq!(keys[1].registered_at_ms, 50);
        assert!(c.owner_keys(accounts(4)).is_empty());
    }

    #[test]
    #[should_panic(expected = "invalid key")]
    fn rejects_passkey_with_ed25519_shape() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("passkey".into(), ED.into(), "Wrong".into());
    }

    #[test]
    #[should_panic(expected = "invalid key")]
    fn rejects_compressed_passkey() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("passkey".into(), format!("03{}", "2".repeat(64)), "Wrong".into());
    }

    #[test]
    #[should_panic(expected = "invalid key")]
    fn rejects_unknown_key_type() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("hardware".into(), ED.into(), "Wrong".into());
    }

    #[test]
    #[should_panic(expected = "duplicate key")]
    fn rejects_duplicate_owner_key() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("passkey".into(), p256(), "One".into());
        c.register_owner_key("passkey".into(), p256(), "Two".into());
    }

    #[test]
    fn owner_revokes_own_key() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("passkey".into(), p256(), "MacBook".into());
        call(3, 70);
        c.revoke_owner_key(p256());
        assert_eq!(c.owner_keys(accounts(3))[0].revoked_at_ms, Some(70));
    }

    #[test]
    #[should_panic(expected = "key not registered")]
    fn other_accounts_cannot_revoke_an_owners_key() {
        let mut c = contract();
        call(3, 50);
        c.register_owner_key("passkey".into(), p256(), "MacBook".into());
        call(4, 60);
        c.revoke_owner_key(p256());
    }

    #[test]
    fn publisher_lists_and_revokes_evidence_keys() {
        let mut c = contract();
        call(1, 30);
        c.register_evidence_key("ev-1".into(), ED.into());
        let key = c.evidence_key("ev-1".into()).unwrap();
        assert_eq!(key.public_key, ED);
        assert_eq!(key.registered_at_ms, 30);
        call(1, 40);
        c.revoke_evidence_key("ev-1".into());
        assert_eq!(c.evidence_key("ev-1".into()).unwrap().revoked_at_ms, Some(40));
        assert!(c.evidence_key("ev-2".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "not publisher")]
    fn only_publisher_lists_evidence_keys() {
        let mut c = contract();
        call(3, 30);
        c.register_evidence_key("ev-1".into(), ED.into());
    }

    #[test]
    #[should_panic(expected = "key id already used")]
    fn evidence_key_ids_are_never_reused() {
        let mut c = contract();
        call(1, 30);
        c.register_evidence_key("ev-1".into(), ED.into());
        c.register_evidence_key("ev-1".into(), R1.into());
    }

    #[test]
    #[should_panic(expected = "invalid key id")]
    fn rejects_bad_evidence_key_id() {
        let mut c = contract();
        call(1, 30);
        c.register_evidence_key("EV 1".into(), ED.into());
    }
}
