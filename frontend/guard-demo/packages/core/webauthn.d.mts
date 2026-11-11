import type { PasskeyAssertion } from './passkey.mjs';

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string;
export function fromBase64Url(value: string): Uint8Array;
export function isPasskeyPublicKey(value: unknown): boolean;
export function derToRaw(der: Uint8Array): Uint8Array;
export function rawToDer(raw: Uint8Array): Uint8Array;
export function passkeyPublicHex(keyOrSpki: CryptoKey | ArrayBuffer): Promise<string>;

export function verifyPasskeySignature(options: {
  publicKey: string;
  hash: string;
  signature: PasskeyAssertion;
  rpId: string;
  allowedOrigins?: string[];
}): Promise<boolean>;
