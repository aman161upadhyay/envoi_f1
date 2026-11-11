import { fromHex, publicHex } from '../../packages/core/crypto.mjs';
import { validAccount } from '../../packages/core/policy.mjs';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const utf8 = new TextEncoder();
const bytes = (...arrays) => Uint8Array.from(arrays.flatMap(array => [...array]));

export function base58Encode(input) {
  let value = input.reduce((number, byte) => number * 256n + BigInt(byte), 0n);
  let output = '';
  while (value) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of input) {
    if (byte) break;
    output = '1' + output;
  }
  return output;
}

export function base58Decode(input) {
  if (typeof input !== 'string' || !input.length || input.length > 100) throw new TypeError('Invalid base58');
  let value = 0n;
  for (const char of input) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new TypeError('Invalid base58');
    value = value * 58n + BigInt(index);
  }
  const output = [];
  while (value) {
    output.push(Number(value % 256n));
    value /= 256n;
  }
  for (const char of input) {
    if (char !== '1') break;
    output.push(0);
  }
  return Uint8Array.from(output.reverse());
}

function uint(value, length) {
  let remaining = BigInt(value);
  if (remaining < 0n || remaining >= 1n << BigInt(length * 8)) throw new RangeError('Integer out of range');
  return Uint8Array.from({ length }, () => {
    const byte = Number(remaining & 255n);
    remaining >>= 8n;
    return byte;
  });
}

const vector = data => bytes(uint(data.length, 4), data);
const string = value => vector(utf8.encode(value));

export function encodeFunctionCall({ sender, receiver, publicKey, blockHash, nonce, method, args, gas }) {
  if (!validAccount(sender) || !validAccount(receiver) || publicKey.length !== 32 || blockHash.length !== 32) {
    throw new TypeError('Invalid NEAR transaction fields');
  }
  // Transaction V0, Ed25519 key, one FunctionCall action, zero attached deposit.
  return bytes(string(sender), [0], publicKey, uint(nonce, 8), string(receiver), blockHash,
    uint(1, 4), [2], string(method), vector(utf8.encode(JSON.stringify(args))), uint(gas, 8), uint(0, 16));
}

export async function callWithScopedKey({ rpc, keys, sender, receiver, method, methods = [method], args, gas = '100000000000000' }) {
  const rawKey = fromHex(await publicHex(keys.publicKey), 32);
  const publicKey = 'ed25519:' + base58Encode(rawKey);
  const key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: sender, public_key: publicKey });
  const permission = key.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== receiver || !methods.includes(method) ||
      permission.method_names.length !== methods.length || !methods.every(name => permission.method_names.includes(name))) {
    throw new Error('This device needs the configured limited testnet access key.');
  }
  if (!Number.isSafeInteger(key.nonce)) throw new Error('Unsupported access key nonce');
  const tx = encodeFunctionCall({
    sender, receiver, publicKey: rawKey, blockHash: base58Decode(key.block_hash),
    nonce: BigInt(key.nonce) + 1n, method, args, gas
  });
  const hash = await crypto.subtle.digest('SHA-256', tx);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, hash));
  const signed = bytes(tx, [0], signature);
  const txRef = base58Encode(new Uint8Array(hash));
  const params = { tx_hash: txRef, sender_account_id: sender, wait_until: 'FINAL' };
  let result;
  try {
    result = await rpc('send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'FINAL' });
  } catch {
    // A timed-out broadcast can already have executed. Query the same transaction before retrying.
    try { result = await rpc('tx', params); } catch { throw new Error('Testnet confirmation unavailable for ' + txRef); }
  }
  if (result.final_execution_status !== 'FINAL') {
    try { result = await rpc('tx', params); } catch { throw new Error('Testnet confirmation unavailable for ' + txRef); }
  }
  if (result.final_execution_status !== 'FINAL' || result.transaction?.hash !== txRef ||
      !Object.hasOwn(result.status ?? {}, 'SuccessValue')) throw new Error('Testnet did not confirm transaction ' + txRef);
  return txRef;
}
