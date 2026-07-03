// SPDX-License-Identifier: MIT
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Authenticator } from "../src/shared/auth.js";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpDir = join(tmpdir(), "wshell-auth-test-" + process.pid);

describe("Authenticator", () => {
  let authPath: string;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    authPath = join(tmpDir, "auth.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("fingerprint", () => {
    it("returns 64-char hex string (full SHA-256)", () => {
      const auth = new Authenticator(authPath);
      const fp = auth.fingerprint("my-token");
      assert.equal(fp.length, 64);
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("is deterministic", () => {
      const auth = new Authenticator(authPath);
      const a = auth.fingerprint("same-token");
      const b = auth.fingerprint("same-token");
      assert.equal(a, b);
    });

    it("different tokens → different fingerprints", () => {
      const auth = new Authenticator(authPath);
      assert.notEqual(auth.fingerprint("token-a"), auth.fingerprint("token-b"));
    });
  });

  describe("addUser + verifyToken", () => {
    it("addUser returns a usable token", async () => {
      const auth = new Authenticator(authPath);
      const token = await auth.addUser("admin", "password123");
      assert.ok(typeof token === "string" && token.length > 0);

      // The returned token should verify.
      assert.equal(auth.verifyToken(token), true);
    });

    it("verifyToken returns false for wrong token", async () => {
      const auth = new Authenticator(authPath);
      await auth.addUser("admin", "password123");
      assert.equal(auth.verifyToken("wrong-token"), false);
    });

    it("verifyToken returns false for empty token", async () => {
      const auth = new Authenticator(authPath);
      await auth.addUser("admin", "password123");
      assert.equal(auth.verifyToken(""), false);
    });

    it("persisted token verifies after reload", async () => {
      const auth = new Authenticator(authPath);
      const token = await auth.addUser("admin", "pw");

      // New instance reads from same file
      const auth2 = new Authenticator(authPath);
      assert.equal(auth2.verifyToken(token), true);
    });
  });

  describe("verifyCredentials", () => {
    it("accepts correct password", async () => {
      const auth = new Authenticator(authPath);
      await auth.addUser("admin", "s3cret");
      assert.equal(await auth.verifyCredentials("admin", "s3cret"), true);
    });

    it("rejects wrong password", async () => {
      const auth = new Authenticator(authPath);
      await auth.addUser("admin", "s3cret");
      assert.equal(await auth.verifyCredentials("admin", "wrong"), false);
    });

    it("rejects unknown user", async () => {
      const auth = new Authenticator(authPath);
      assert.equal(await auth.verifyCredentials("nobody", "x"), false);
    });
  });

  describe("listUsers / deleteUser", () => {
    it("listUsers includes added users", async () => {
      const auth = new Authenticator(authPath);
      await auth.addUser("user1", "p1");
      await auth.addUser("user2", "p2");
      const users = auth.listUsers();
      assert.ok(users.includes("user1"));
      assert.ok(users.includes("user2"));
    });

    it("deleteUser removes the user", async () => {
      const auth = new Authenticator(authPath);
      await auth.addUser("temp", "pw");
      assert.equal(auth.deleteUser("temp"), true);
      assert.equal(auth.listUsers().includes("temp"), false);
    });

    it("deleteUser returns false for unknown user", () => {
      const auth = new Authenticator(authPath);
      assert.equal(auth.deleteUser("ghost"), false);
    });
  });
});
