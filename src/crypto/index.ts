// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * Encryption Module (libsodium via sodium-native)
 *
 * Uses XChaCha20-Poly1305 (secretbox) for authenticated encryption.
 *
 * Key derivation:
 *   1. Client and server share a pre-shared key (from auth token)
 *   2. Both derive a 32-byte subkey using crypto_kdf
 *   3. Each message gets a unique 24-byte nonce (random)
 *   4. Messages are encrypted with crypto_secretbox_easy
 *
 * Wire format (after auth):
 *   [4 bytes length][24 bytes nonce][ciphertext ...]
 *
 * Before auth, messages are plaintext JSON.
 */

import sodium from "sodium-native";

/**
 * Initialize crypto (no-op, sodium-native is ready on load).
 */
export async function initCrypto(): Promise<void> {
  // sodium-native is ready immediately
}

/**
 * Derive a 32-byte subkey from a shared secret using crypto_kdf.
 * The derivation is deterministic: same input produces same key.
 */
export function deriveKey(sharedSecret: string): Buffer {
  // Hash the shared secret to create a deterministic master key
  const secretBuf = Buffer.from(sharedSecret, "utf8");
  const masterKey = Buffer.alloc(sodium.crypto_kdf_KEYBYTES);

  // Use crypto_generichash (blake2b) to hash the secret into a key
  sodium.crypto_generichash(masterKey, secretBuf);

  const context = Buffer.from("wshllv1_", "utf8"); // 8 bytes required
  const subkey = Buffer.alloc(32);
  sodium.crypto_kdf_derive_from_key(subkey, 0, context, masterKey);

  // Wipe master key
  masterKey.fill(0);

  return subkey;
}

/**
 * Encrypt a plaintext string. Returns packed buffer.
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
  sodium.randombytes_buf(nonce);

  const msgBuf = Buffer.from(plaintext, "utf8");
  const ciphertext = Buffer.alloc(msgBuf.length + sodium.crypto_secretbox_MACBYTES);

  sodium.crypto_secretbox_easy(ciphertext, msgBuf, nonce, key);

  // Pack: [4 bytes nonce length][nonce][ciphertext]
  const packed = Buffer.alloc(4 + nonce.length + ciphertext.length);
  packed.writeUInt32BE(nonce.length, 0);
  nonce.copy(packed, 4);
  ciphertext.copy(packed, 4 + nonce.length);

  return packed;
}

/**
 * Decrypt a packed message. Returns plaintext string.
 */
export function decrypt(packed: Buffer, key: Buffer): string | null {
  if (packed.length < 4) return null;

  const nonceLen = packed.readUInt32BE(0);
  if (packed.length < 4 + nonceLen + sodium.crypto_secretbox_MACBYTES) return null;

  const nonce = packed.subarray(4, 4 + nonceLen);
  const ciphertext = packed.subarray(4 + nonceLen);

  const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES);

  try {
    const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key);
    if (!success) return null;
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
