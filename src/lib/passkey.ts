import type { PasskeyCredential, PasskeySignature } from './types.js';

const PASSKEY_RP_NAME = 'Passkey Wallet';

/**
 * Create a new passkey (WebAuthn credential).
 * @param accountId - NEAR account name stored in the passkey for login recovery.
 */
export async function createPasskey(accountId: string): Promise<PasskeyCredential> {
  // pages.dev is on the public suffix list — can't use it as rpId
  // Must use the full subdomain (e.g. near-passkey-wallet.pages.dev)
  const rpId = window.location.hostname;
  // Embed account name so we can recover it on a new device via passkey sync
  const userId = new TextEncoder().encode(accountId);

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: PASSKEY_RP_NAME, id: rpId },
      user: {
        id: userId,
        name: accountId,
        displayName: accountId,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },   // Ed25519
        { type: 'public-key', alg: -7 },    // P-256 (fallback)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
    },
  }) as PublicKeyCredential & { response: AuthenticatorAttestationResponse & { getPublicKey(): ArrayBuffer | null; getPublicKeyAlgorithm(): number } };

  const response = credential.response;
  const pubKeyBuffer = response.getPublicKey();
  if (!pubKeyBuffer) throw new Error('No public key returned from credential creation');
  return {
    id: credential.id,
    rawId: new Uint8Array(credential.rawId),
    publicKey: {
      raw: new Uint8Array(pubKeyBuffer),
      alg: response.getPublicKeyAlgorithm(),
    },
  };
}

/**
 * Sign a challenge with the passkey.
 * The challenge is SHA256("NEAR_WALLET_CONTRACT/V1" + borsh(RequestMessage))
 */
export async function signWithPasskey(
  credentialRawId: Uint8Array,
  challengeHash: Uint8Array,
): Promise<PasskeySignature> {
  // WebAuthn challenge must be a Uint8Array
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: challengeHash as BufferSource,
      allowCredentials: [{
        type: 'public-key',
        id: credentialRawId as BufferSource,
      }],
      userVerification: 'required',
      timeout: 60000,
    },
  }) as PublicKeyCredential & { response: AuthenticatorAssertionResponse };

  return {
    authenticatorData: new Uint8Array(assertion.response.authenticatorData),
    clientDataJSON: new TextDecoder().decode(assertion.response.clientDataJSON),
    signature: new Uint8Array(assertion.response.signature),
  };
}
