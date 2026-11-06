//! envoi-record: the public record behind envoi evidence proofs.
//!
//! * `seal` stores one Merkle root per evidence batch. Batches must arrive in order and each
//!   one names the previous root, so history can't be rewritten or skipped.
//! * `register_key` lists signing-key fingerprints (envoi's evidence keys and owners' passkeys)
//!   with the block time, append only. The checker uses it to prove a device was listed before
//!   it signed a permission.
//!
//! Only 32-byte roots, counts, salted owner references and key fingerprints are stored. No names,
//! messages, files or workspace IDs. The proof format is documented in docs/proof-format.md.
//!
//! There is deliberately no upgrade method: deploy, initialise, then delete the account's
//! full-access keys so nobody (including envoi) can change this code.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const EVENT_STANDARD: &str = "envoi-record";
const EVENT_VERSION: &str = "1.0.0";
const MAX_REF_LEN: usize = 128;
const KINDS: [&str; 3] = ["envoi", "owner", "owner_demo"];
const ALGS: [&str; 2] = ["Ed25519", "ES256"];

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Root {
    pub root: String,
    pub previous_root: Option<String>,
    pub count: u32,
    /// Block timestamp in nanoseconds, as a string in JSON.
    pub block_ts: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyEntry {
    pub kind: String,
    pub key_ref: String,
    pub key_id: String,
    pub fingerprint: String,
    pub alg: String,
    pub prev_sig_ref: Option<String>,
    pub block_ts: U64,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Roots,
    Keys,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EnvoiRecord {
    publisher: AccountId,
    last_batch_id: u64,
    last_root: Option<String>,
    roots: LookupMap<u64, Root>,
    keys: LookupMap<String, Vec<KeyEntry>>,
    key_count: u64,
}

fn is_hex32(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    ));
}

#[near]
impl EnvoiRecord {
    #[init]
    pub fn new(publisher: AccountId) -> Self {
        Self {
            publisher,
            last_batch_id: 0,
            last_root: None,
            roots: LookupMap::new(StorageKey::Roots),
            keys: LookupMap::new(StorageKey::Keys),
            key_count: 0,
        }
    }

    fn assert_publisher(&self) {
        require!(env::predecessor_account_id() == self.publisher, "not publisher");
    }

    /// Publish the root of the next evidence batch.
    pub fn seal(&mut self, batch_id: u64, root: String, previous_root: Option<String>, count: u32) {
        self.assert_publisher();
        require!(batch_id == self.last_batch_id + 1, "out of order");
        require!(previous_root == self.last_root, "bad link");
        require!(is_hex32(&root), "root must be 32-byte lowercase hex");
        require!(count > 0, "empty batch");
        let entry = Root { root: root.clone(), previous_root: previous_root.clone(), count, block_ts: U64(env::block_timestamp()) };
        self.roots.insert(batch_id, entry);
        self.last_batch_id = batch_id;
        self.last_root = Some(root.clone());
        emit("seal", json!({ "batch_id": batch_id, "root": root, "previous_root": previous_root, "count": count }));
    }

    /// List a signing key's fingerprint. Append only; the same fingerprint can't be listed twice
    /// under one reference.
    pub fn register_key(
        &mut self,
        kind: String,
        key_ref: String,
        key_id: String,
        fingerprint: String,
        alg: String,
        prev_sig_ref: Option<String>,
    ) {
        self.assert_publisher();
        require!(KINDS.contains(&kind.as_str()), "kind must be envoi, owner or owner_demo");
        require!(ALGS.contains(&alg.as_str()), "alg must be Ed25519 or ES256");
        require!(!key_ref.is_empty() && key_ref.len() <= MAX_REF_LEN, "bad key_ref");
        require!(!key_id.is_empty() && key_id.len() <= MAX_REF_LEN, "bad key_id");
        require!(is_hex32(&fingerprint), "fingerprint must be 32-byte lowercase hex");
        if let Some(sig) = &prev_sig_ref {
            require!(sig.len() <= 512, "prev_sig_ref too long");
        }
        let mut list = self.keys.get(&key_ref).cloned().unwrap_or_default();
        require!(!list.iter().any(|k| k.fingerprint == fingerprint), "key already listed");
        let entry = KeyEntry {
            kind: kind.clone(),
            key_ref: key_ref.clone(),
            key_id: key_id.clone(),
            fingerprint: fingerprint.clone(),
            alg,
            prev_sig_ref,
            block_ts: U64(env::block_timestamp()),
        };
        list.push(entry);
        self.keys.insert(key_ref.clone(), list);
        self.key_count += 1;
        emit("register_key", json!({ "kind": kind, "key_ref": key_ref, "key_id": key_id, "fingerprint": fingerprint }));
    }

    /// Hand publishing to a new account (for key rotation). The old publisher must call it.
    pub fn set_publisher(&mut self, next: AccountId) {
        self.assert_publisher();
        emit("set_publisher", json!({ "previous": self.publisher, "next": next }));
        self.publisher = next;
    }

    pub fn root_of(&self, batch_id: u64) -> Option<Root> {
        self.roots.get(&batch_id).cloned()
    }

    pub fn keys_of(&self, key_ref: String) -> Vec<KeyEntry> {
        self.keys.get(&key_ref).cloned().unwrap_or_default()
    }

    pub fn last(&self) -> (u64, Option<String>) {
        (self.last_batch_id, self.last_root.clone())
    }

    pub fn publisher(&self) -> AccountId {
        self.publisher.clone()
    }

    pub fn key_count(&self) -> u64 {
        self.key_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const R1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const R2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const FP: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn as_account(who: AccountId, ts: u64) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who).block_timestamp(ts).build());
    }

    fn contract() -> EnvoiRecord {
        as_account(accounts(0), 1);
        EnvoiRecord::new(accounts(1))
    }

    #[test]
    fn seals_in_order_and_chains_roots() {
        let mut c = contract();
        as_account(accounts(1), 1_000);
        c.seal(1, R1.to_string(), None, 3);
        as_account(accounts(1), 2_000);
        c.seal(2, R2.to_string(), Some(R1.to_string()), 1);
        let r = c.root_of(2).unwrap();
        assert_eq!(r.root, R2);
        assert_eq!(r.previous_root.as_deref(), Some(R1));
        assert_eq!(r.block_ts, U64(2_000));
        assert_eq!(c.last(), (2, Some(R2.to_string())));
        assert!(c.root_of(3).is_none());
    }

    #[test]
    #[should_panic(expected = "out of order")]
    fn rejects_skipped_batch() {
        let mut c = contract();
        as_account(accounts(1), 1);
        c.seal(2, R1.to_string(), None, 1);
    }

    #[test]
    #[should_panic(expected = "bad link")]
    fn rejects_broken_chain() {
        let mut c = contract();
        as_account(accounts(1), 1);
        c.seal(1, R1.to_string(), None, 1);
        c.seal(2, R2.to_string(), None, 1);
    }

    #[test]
    #[should_panic(expected = "not publisher")]
    fn only_publisher_can_seal() {
        let mut c = contract();
        as_account(accounts(2), 1);
        c.seal(1, R1.to_string(), None, 1);
    }

    #[test]
    #[should_panic(expected = "root must be 32-byte lowercase hex")]
    fn rejects_bad_root() {
        let mut c = contract();
        as_account(accounts(1), 1);
        c.seal(1, "ABC".to_string(), None, 1);
    }

    #[test]
    fn registers_keys_append_only_with_block_time() {
        let mut c = contract();
        as_account(accounts(1), 5_000);
        c.register_key("owner".into(), "ref".into(), "k1".into(), FP.into(), "ES256".into(), None);
        let keys = c.keys_of("ref".into());
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].block_ts, U64(5_000));
        assert_eq!(c.key_count(), 1);
        assert!(c.keys_of("other".into()).is_empty());
    }

    #[test]
    #[should_panic(expected = "key already listed")]
    fn rejects_duplicate_key() {
        let mut c = contract();
        as_account(accounts(1), 1);
        c.register_key("owner".into(), "ref".into(), "k1".into(), FP.into(), "ES256".into(), None);
        c.register_key("owner".into(), "ref".into(), "k2".into(), FP.into(), "ES256".into(), None);
    }

    #[test]
    #[should_panic(expected = "kind must be envoi, owner or owner_demo")]
    fn rejects_unknown_kind() {
        let mut c = contract();
        as_account(accounts(1), 1);
        c.register_key("admin".into(), "ref".into(), "k1".into(), FP.into(), "ES256".into(), None);
    }

    #[test]
    #[should_panic(expected = "not publisher")]
    fn only_publisher_can_register() {
        let mut c = contract();
        as_account(accounts(3), 1);
        c.register_key("owner".into(), "ref".into(), "k1".into(), FP.into(), "ES256".into(), None);
    }

    #[test]
    fn publisher_rotation() {
        let mut c = contract();
        as_account(accounts(1), 1);
        c.set_publisher(accounts(2));
        assert_eq!(c.publisher(), accounts(2));
        as_account(accounts(2), 2);
        c.seal(1, R1.to_string(), None, 1);
    }
}
