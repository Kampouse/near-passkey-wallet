import bs58 from 'bs58';

// ─── Base58 helpers ──────────────────────────────────────

export function base58Encode(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

export function base58Decode(str: string): Uint8Array {
  return bs58.decode(str);
}

// ─── Base64 / Hex encoding helpers ──────────────────────

export function uint8ToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function uint8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToUint8(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.substr(i, 2), 16);
  return bytes;
}

// ─── Concat helper ──────────────────────────────────────

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ─── Display helpers ────────────────────────────────────

export function formatEthBalance(weiBigInt: bigint | number): string {
  const eth = Number(weiBigInt) / 1e18;
  if (eth === 0) return '0';
  if (eth < 0.0001) return '<0.0001';
  return eth.toFixed(4);
}

// ─── Security ───────────────────────────────────────────

/**
 * Generate a cryptographically secure random nonce.
 * SECURITY FIX: Uses crypto.getRandomValues instead of Math.random.
 */
export function generateSecureNonce(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

// ─── Nostr helpers ──────────────────────────────────────

/**
 * Convert base58 string to Uint8Array
 */
export function base58ToBytes(base58: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(0);

  for (let i = 0; i < base58.length; i++) {
    const char = base58[i];
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert to bytes
  const hex = num.toString(16).padStart(64, '0'); // 32 bytes = 64 hex chars
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  // Handle leading zeros
  let leadingZeros = 0;
  for (let i = 0; i < base58.length && base58[i] === '1'; i++) {
    leadingZeros++;
  }
  if (leadingZeros > 0) {
    const withZeros = new Uint8Array(leadingZeros + result.length);
    withZeros.set(result, leadingZeros);
    return withZeros;
  }

  return result;
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert bytes to npub (bech32)
 */
export function bytesToNpub(bytes: Uint8Array): string {
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  // Convert 8-bit to 5-bit
  const fiveBit: number[] = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      fiveBit.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) {
    fiveBit.push((acc << (5 - bits)) & 31);
  }

  // Add checksum
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  const values = [...'npub'.split('').map(c => c.charCodeAt(0) >> 5), 0, ...'npub'.split('').map(c => c.charCodeAt(0) & 31), ...fiveBit, 0, 0, 0, 0, 0, 0];
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((chk >> (5 * (5 - i))) & 31);
  }

  const combined = [...fiveBit, ...checksum];
  return 'npub1' + combined.map(v => BECH32_CHARSET[v]).join('');
}

// ─── Solana helpers ─────────────────────────────────────

/**
 * Encode a compact-u16 value (Solana's variable-length encoding).
 */
export function encodeCompactU16(value: number): Uint8Array {
  if (value < 128) {
    return new Uint8Array([value]);
  } else if (value < 16384) {
    return new Uint8Array([
      (value & 0x7f) | 0x80,
      (value >> 7) & 0x7f,
    ]);
  } else {
    return new Uint8Array([
      (value & 0x7f) | 0x80,
      ((value >> 7) & 0x7f) | 0x80,
      (value >> 14) & 0x03,
    ]);
  }
}

/**
 * Concatenate Uint8Arrays.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
