// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveKey,
  encrypt,
  decrypt,
  packEncrypted,
  packPlain,
  unpackFrame,
  FRAME_PLAIN,
  FRAME_ENCRYPTED,
} from "../src/crypto/index.js";

describe("deriveKey", () => {
  it("is deterministic — same input → same output", () => {
    const k1 = deriveKey("my-secret-token");
    const k2 = deriveKey("my-secret-token");
    assert.deepEqual(k1, k2);
  });

  it("different inputs → different keys", () => {
    const k1 = deriveKey("token-a");
    const k2 = deriveKey("token-b");
    assert.notDeepEqual(k1, k2);
  });

  it("produces a 32-byte key", () => {
    const key = deriveKey("test");
    assert.equal(key.length, 32);
  });
});

describe("encrypt / decrypt (legacy helpers)", () => {
  const key = deriveKey("round-trip-test");

  it("round-trip: decrypt(encrypt(x)) === x", () => {
    const plain = 'hello world {"json":" ✓"}';
    const packed = encrypt(plain, key);
    const result = decrypt(packed, key);
    assert.equal(result, plain);
  });

  it("decrypt returns null on tampered ciphertext", () => {
    const packed = encrypt("secret", key);
    packed[packed.length - 1] ^= 0x01; // flip last byte
    assert.equal(decrypt(packed, key), null);
  });

  it("decrypt returns null with wrong key", () => {
    const packed = encrypt("secret", key);
    const wrongKey = deriveKey("different");
    assert.equal(decrypt(packed, wrongKey), null);
  });

  it("decrypt returns null on truncated buffer", () => {
    assert.equal(decrypt(Buffer.alloc(5), key), null);
  });
});

describe("packEncrypted / unpackFrame (wire format)", () => {
  const key = deriveKey("wire-test");
  const json = '{"type":"ping","id":"abc","ts":123,"payload":{}}';

  it("packEncrypted starts with 0x01 type byte", () => {
    const wire = packEncrypted(json, key);
    assert.equal(wire[0], FRAME_ENCRYPTED);
  });

  it("round-trip: unpackFrame(packEncrypted(x)) === x", () => {
    const wire = packEncrypted(json, key);
    const result = unpackFrame(wire, key);
    assert.equal(result.kind, "encrypted");
    assert.equal(result.text, json);
  });

  it("packPlain starts with 0x00 type byte", () => {
    const wire = packPlain(json);
    assert.equal(wire[0], FRAME_PLAIN);
  });

  it("unpackFrame reads plaintext frames", () => {
    const wire = packPlain(json);
    const result = unpackFrame(wire, null);
    assert.equal(result.kind, "plain");
    assert.equal(result.text, json);
  });

  it("rejects encrypted frame when no key provided", () => {
    const wire = packEncrypted(json, key);
    const result = unpackFrame(wire, null);
    assert.equal(result.kind, "error");
  });

  it("rejects empty frame", () => {
    const result = unpackFrame(Buffer.alloc(0), key);
    assert.equal(result.kind, "error");
  });

  it("rejects unknown type byte", () => {
    const wire = Buffer.from([0xff, 0x00, 0x01]);
    const result = unpackFrame(wire, key);
    assert.equal(result.kind, "error");
  });

  it("rejects tampered encrypted frame (MAC mismatch)", () => {
    const wire = packEncrypted(json, key);
    wire[wire.length - 1] ^= 0x01;
    const result = unpackFrame(wire, key);
    assert.equal(result.kind, "error");
  });
});
