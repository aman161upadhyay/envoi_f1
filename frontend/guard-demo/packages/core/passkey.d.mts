export interface OwnerPasskey {
  credentialId: string;
  publicKey: string;
  rpId: string;
}

export interface PasskeyAssertion {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export function createPasskey(options: {
  ownerAccount: string;
  rpId?: string;
  rpName?: string;
  displayName?: string;
}): Promise<OwnerPasskey>;

export function signWithPasskey(options: {
  credentialId: string;
  hash: string;
  rpId?: string;
}): Promise<PasskeyAssertion>;
