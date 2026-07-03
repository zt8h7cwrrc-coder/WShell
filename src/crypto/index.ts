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
 * Frame format (single, unambiguous scheme):
 *   ┌────────┬───────────────────┬──────────────────────┐
 *   │ type   │ nonce (24 bytes)  │ ciphertext + MAC     │
 *   │ 1 byte │                   │ (payload + 16 bytes) │
 *   └────────┴───────────────────┴──────────────────────┘
 *   type = 0x01  →  encrypted frame (secretbox)
 *   type = 0x00  →  plaintext JSON frame (pre-auth only)
 *
 * Before auth, messages are plaintext JSON.
 */

import sodium from "sodium-native";

/** Frame type byte: plaintext JSON. */
export const FRAME_PLAIN = 0x00;
/** Frame type byte: encrypted (XChaCha20-Poly1305). */
export const FRAME_ENCRYPTED = 0x01;

/** Nonce length for XChaCha20-Poly1305 (secretbox with 24-byte nonce). */
export const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES;
/** MAC length appended by secretbox. */
export const MAC_BYTES = sodium.crypto_secretbox_MACBYTES;

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
 * Encrypt a plaintext string into a full wire frame including the
 * type byte: `[0x01][nonce 24B][ciphertext]`.
 */
export function packEncrypted(plaintext: string, key: Buffer): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  sodium.randombytes_buf(nonce);

  const msgBuf = Buffer.from(plaintext, "utf8");
  const ciphertext = Buffer.alloc(msgBuf.length + MAC_BYTES);

  sodium.crypto_secretbox_easy(ciphertext, msgBuf, nonce, key);

  const wire = Buffer.allocUnsafe(1 + nonce.length + ciphertext.length);
  wire[0] = FRAME_ENCRYPTED;
  nonce.copy(wire, 1);
  ciphertext.copy(wire, 1 + nonce.length);

  return wire;
}

/**
 * Pack a plaintext JSON frame: `[0x00][utf8 json]`.
 */
export function packPlain(plaintext: string): Buffer {
  const json = Buffer.from(plaintext, "utf8");
  const wire = Buffer.allocUnsafe(1 + json.length);
  wire[0] = FRAME_PLAIN;
  json.copy(wire, 1);
  return wire;
}

/** Result of {@link unpackFrame}. */
export type FrameResult =
  | { kind: "plain"; text: string }
  | { kind: "encrypted"; text: string }
  | { kind: "error"; reason: string };

/**
 * Unpack a wire frame received over the WebSocket.
 *
 * Decides framing purely from the leading type byte, regardless of the
 * caller's `expectEncrypted` hint (the hint only selects the key used for
 * decryption attempts and is returned as-is otherwise).
 *
 * @param buf      Raw bytes from the WebSocket.
 * @param encKey   Encryption key, or null if not yet established.
 */
export function unpackFrame(buf: Buffer, encKey: Buffer | null): FrameResult {
  if (buf.length < 1) return { kind: "error", reason: "empty frame" };

  const type = buf[0];
  const body = buf.subarray(1);

  if (type === FRAME_PLAIN) {
    return { kind: "plain", text: body.toString("utf8") };
  }

  if (type === FRAME_ENCRYPTED) {
    if (!encKey) return { kind: "error", reason: "encrypted frame without key" };
    if (body.length < NONCE_BYTES + MAC_BYTES) {
      return { kind: "error", reason: "truncated encrypted frame" };
    }
    const nonce = body.subarray(0, NONCE_BYTES);
    const ciphertext = body.subarray(NONCE_BYTES);
    const plaintext = Buffer.allocUnsafe(ciphertext.length - MAC_BYTES);
    try {
      const ok = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, encKey);
      if (!ok) return { kind: "error", reason: "authentication tag mismatch" };
      return { kind: "encrypted", text: plaintext.toString("utf8") };
    } catch {
      return { kind: "error", reason: "decryption threw" };
    }
  }

  return { kind: "error", reason: `unknown frame type 0x${type.toString(16).padStart(2, "0")}` };
}

/* ── Backwards-compatible helpers (used internally by both peers) ──────── */

/**
 * Encrypt a plaintext string. Returns `[nonce][ciphertext]` (no type byte).
 * Kept for tests and low-level use; prefer {@link packEncrypted} on the wire.
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  sodium.randombytes_buf(nonce);

  const msgBuf = Buffer.from(plaintext, "utf8");
  const ciphertext = Buffer.alloc(msgBuf.length + MAC_BYTES);

  sodium.crypto_secretbox_easy(ciphertext, msgBuf, nonce, key);

  const packed = Buffer.alloc(nonce.length + ciphertext.length);
  nonce.copy(packed, 0);
  ciphertext.copy(packed, nonce.length);

  return packed;
}

/**
 * Decrypt a `[nonce][ciphertext]` buffer. Returns plaintext string or null.
 * Kept for tests; the wire path uses {@link unpackFrame}.
 */
export function decrypt(packed: Buffer, key: Buffer): string | null {
  if (packed.length < NONCE_BYTES + MAC_BYTES) return null;

  const nonce = packed.subarray(0, NONCE_BYTES);
  const ciphertext = packed.subarray(NONCE_BYTES);
  const plaintext = Buffer.alloc(ciphertext.length - MAC_BYTES);

  try {
    const ok = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key);
    if (!ok) return null;
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
