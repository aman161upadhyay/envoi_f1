// "Demo device": a software WebAuthn authenticator so judges, CI and the demo script can sign
// permissions without hardware. Its assertions are byte-compatible with a real passkey, and
// every proof signed with it says method "demo_device" and lists the key as kind "owner_demo".
import { bytesToBase64Url, concatBytes, hexToBytes, utf8 } from './bytes.js';
import { publicJwk, sha256 } from './hash.js';
import { rawToDer } from './signatures.js';

const subtle = () => globalThis.crypto.subtle;

export const createDemoDevice = async ({ privateJwk } = {}) => {
  let priv = privateJwk;
  let pub;
  if (!priv) {
    const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    priv = await subtle().exportKey('jwk', pair.privateKey);
  }
  pub = publicJwk(priv);
  const signingKey = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, d: priv.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  let counter = 0;

  const sign = async ({ documentHash, rpId, rpOrigin }) => {
    const clientDataJSON = utf8(JSON.stringify({
      type: 'webauthn.get',
      challenge: bytesToBase64Url(hexToBytes(documentHash)),
      origin: rpOrigin,
      crossOrigin: false,
    }));
    const flags = 0x01 | 0x04; // user present, user verified
    const countBytes = new Uint8Array(4);
    new DataView(countBytes.buffer).setUint32(0, counter, false);
    const authenticatorData = concatBytes(await sha256(utf8(rpId)), Uint8Array.of(flags), countBytes);
    const signed = concatBytes(authenticatorData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, signed));
    return {
      authenticatorData: bytesToBase64Url(authenticatorData),
      clientDataJSON: bytesToBase64Url(clientDataJSON),
      signature: bytesToBase64Url(rawToDer(raw)),
    };
  };

  return { publicJwk: pub, privateJwk: priv, sign };
};
