import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fromHex } from '../../packages/core/crypto.mjs';
import { ZERO_ROOT } from '../../packages/core/tree.mjs';
import { parseAmount, refusalReason, validAccount } from '../../packages/core/policy.mjs';
import { isPasskeyPublicKey } from '../../packages/core/webauthn.mjs';

export function createLocalAdapters(path = ':memory:', clock = Date.now) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY, tx TEXT UNIQUE, payload TEXT);
    CREATE TABLE IF NOT EXISTS owner_keys (owner TEXT, key TEXT, payload TEXT, PRIMARY KEY(owner, key));
    CREATE TABLE IF NOT EXISTS evidence_keys (id TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE IF NOT EXISTS vaults (owner TEXT PRIMARY KEY, balance TEXT);
    CREATE TABLE IF NOT EXISTS policies (agent TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE IF NOT EXISTS daily (agent TEXT, day INTEGER, amount TEXT, PRIMARY KEY(agent, day));
    CREATE TABLE IF NOT EXISTS outcomes (tx TEXT PRIMARY KEY, payload TEXT);
    CREATE TABLE IF NOT EXISTS agent_keys (agent TEXT PRIMARY KEY, payload TEXT);
  `);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const read = (sql, ...params) => JSON.parse(get(sql, ...params)?.payload ?? 'null');
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const network = 'local';
  const getPolicy = agent => read('SELECT payload FROM policies WHERE agent = ?', agent);
  const lookup = (owner, key) => read('SELECT payload FROM owner_keys WHERE owner = ? AND key = ?', owner, key);
  const vaultOf = owner => get('SELECT balance FROM vaults WHERE owner = ?', owner)?.balance ?? '0';
  const setBalance = (owner, amount) => run('INSERT OR REPLACE INTO vaults VALUES (?, ?)', owner, String(amount));

  return {
    db,
    publicRecord: {
      network,
      async seal({ batchId, root, previousRoot, count }) {
        return transaction(() => {
          fromHex(root, 32);
          const last = get('SELECT id, payload FROM batches ORDER BY id DESC LIMIT 1');
          if (!Number.isSafeInteger(count) || count <= 0 || batchId !== (last?.id ?? 0) + 1 ||
              previousRoot !== (last ? JSON.parse(last.payload).root : ZERO_ROOT)) throw new Error('Invalid batch');
          const txRef = randomUUID();
          run('INSERT INTO batches VALUES (?, ?, ?)', batchId, txRef, JSON.stringify({ root, previousRoot, count, txRef, sealedAtMs: clock() }));
          return { txRef };
        });
      },
      async status(txRef) { return get('SELECT id FROM batches WHERE tx = ?', txRef) ? 'final' : 'failed'; },
      async readRoot(id) { return read('SELECT payload FROM batches WHERE id = ?', id); },
      async describeContract() { return { address: 'local-record', codeHash: ZERO_ROOT, locked: false }; }
    },
    ownerRegistry: {
      network,
      async lookup(owner, key) { return lookup(owner, key); },
      async register(owner, { type, publicKey, label }) {
        // Same key rules as the record contract's register_owner_key.
        if (!validAccount(owner) || !['demo_device', 'passkey'].includes(type) || typeof label !== 'string' || !label.length || label.length > 64) throw new Error('Invalid key');
        const shapeOk = type === 'passkey' ? isPasskeyPublicKey(publicKey) : /^[0-9a-f]{64}$/.test(publicKey);
        if (!shapeOk) throw new Error('Invalid key');
        return transaction(() => {
          if (get('SELECT COUNT(*) AS n FROM owner_keys WHERE owner = ?', owner).n >= 10) throw new Error('Key limit reached');
          run('INSERT INTO owner_keys VALUES (?, ?, ?)', owner, publicKey, JSON.stringify({ type, label, registeredAtMs: clock() }));
          return { txRef: randomUUID() };
        });
      },
      async revoke(owner, publicKey) {
        return transaction(() => {
          const key = lookup(owner, publicKey);
          if (!key || key.revokedAtMs !== undefined) throw new Error('No active key');
          run('UPDATE owner_keys SET payload = ? WHERE owner = ? AND key = ?', JSON.stringify({ ...key, revokedAtMs: clock() }), owner, publicKey);
          return { txRef: randomUUID() };
        });
      }
    },
    // Mirrors the record contract's register_evidence_key / revoke_evidence_key / evidence_key.
    evidenceRegistry: {
      network,
      async lookup(keyId) { return read('SELECT payload FROM evidence_keys WHERE id = ?', keyId); },
      async register(keyId, publicKey) {
        if (typeof keyId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(keyId) || !/^[0-9a-f]{64}$/.test(publicKey)) throw new Error('Invalid key');
        return transaction(() => {
          if (get('SELECT id FROM evidence_keys WHERE id = ?', keyId)) throw new Error('Key id already used');
          run('INSERT INTO evidence_keys VALUES (?, ?)', keyId, JSON.stringify({ publicKey, registeredAtMs: clock() }));
          return { txRef: randomUUID() };
        });
      },
      async revoke(keyId) {
        return transaction(() => {
          const key = read('SELECT payload FROM evidence_keys WHERE id = ?', keyId);
          if (!key || key.revokedAtMs !== undefined) throw new Error('No active key');
          run('UPDATE evidence_keys SET payload = ? WHERE id = ?', JSON.stringify({ ...key, revokedAtMs: clock() }), keyId);
          return { txRef: randomUUID() };
        });
      }
    },
    spendGuard: {
      network,
      unit: 'yoctoNEAR',
      async vaultOf(owner) { return vaultOf(owner); },
      async deposit(owner, amount) {
        transaction(() => setBalance(owner, parseAmount(String(parseAmount(vaultOf(owner)) + parseAmount(amount)))));
      },
      async registerAgent(owner, agent, publicKey) {
        if (!validAccount(owner) || !validAccount(agent)) throw new Error('Invalid account');
        fromHex(publicKey, 32);
        transaction(() => {
          run('INSERT INTO policies VALUES (?, ?)', agent, JSON.stringify({ owner, payees: [], dailyCap: '0', paused: false, version: 0 }));
          run('INSERT INTO agent_keys VALUES (?, ?)', agent, JSON.stringify([{ publicKey, kind: 'function_call', receiver: 'local-spend', methods: ['pay'], allowance: '250000000000000000000000' }]));
        });
      },
      async getPolicy(agent) { return getPolicy(agent); },
      async setPolicy(owner, agent, { payees, dailyCap, paused }, policyHash) {
        return transaction(() => {
          const current = getPolicy(agent);
          if (current?.owner !== owner) throw new Error('Owner required');
          fromHex(policyHash, 32);
          const cap = parseAmount(dailyCap);
          if (typeof paused !== 'boolean' || new Set(payees.map(payee => payee.account)).size !== payees.length ||
              payees.some(payee => !validAccount(payee.account) || parseAmount(payee.maxPerPayment) === 0n || parseAmount(payee.maxPerPayment) > cap)) throw new Error('Invalid policy');
          const policy = { owner, payees, dailyCap, paused, policyHash, version: current.version + 1 };
          run('UPDATE policies SET payload = ? WHERE agent = ?', JSON.stringify(policy), agent);
          return { txRef: randomUUID() };
        });
      },
      async pay(agent, to, amount, caseRef) {
        return transaction(() => {
          if (!validAccount(agent) || !validAccount(to) || typeof caseRef !== 'string' || !caseRef.length || caseRef.length > 128) throw new Error('Invalid payment');
          const policy = getPolicy(agent);
          const day = Math.floor(clock() / 86400000);
          const spent = parseAmount(get('SELECT amount FROM daily WHERE agent = ? AND day = ?', agent, day)?.amount ?? '0');
          const balance = parseAmount(vaultOf(policy?.owner ?? ''));
          const reason = refusalReason({ policy, to, amount, spent, balance });
          const txRef = randomUUID();
          const outcome = { status: reason ? 'refused' : 'paid', txRef, to, amount, agent, caseRef, policyHash: policy?.policyHash ?? null };
          if (reason) outcome.reason = reason;
          else {
            const value = parseAmount(amount);
            setBalance(policy.owner, balance - value);
            run('INSERT OR REPLACE INTO daily VALUES (?, ?, ?)', agent, day, String(spent + value));
          }
          run('INSERT INTO outcomes VALUES (?, ?)', txRef, JSON.stringify(outcome));
          return outcome;
        });
      },
      async readOutcome(txRef) { return read('SELECT payload FROM outcomes WHERE tx = ?', txRef); }
    },
    agentAccounts: {
      network,
      async describe(agent) { return { account: agent, keys: read('SELECT payload FROM agent_keys WHERE agent = ?', agent) ?? [] }; }
    }
  };
}
