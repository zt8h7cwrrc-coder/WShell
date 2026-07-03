// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * Authentication Module
 *
 * Users are identified by username + password.
 * Passwords are hashed with bcrypt (10 rounds).
 * API access uses random tokens, stored as SHA-256 fingerprints (full digest,
 * not truncated) for constant-time lookup.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { dirname, join } from "path";
import { homedir } from "os";
import bcrypt from "bcryptjs";

interface StoredUser {
  passwordHash: string;
  tokenFingerprints: string[];
}

interface AuthData {
  users: Record<string, StoredUser>;
}

/** Default auth file: ~/.wshell/auth.json (lives alongside client config). */
export const DEFAULT_AUTH_FILE = join(homedir(), ".wshell", "auth.json");

const BCRYPT_ROUNDS = 10;

export class Authenticator {
  private dataPath: string;
  private data: AuthData;

  constructor(dataPath: string = DEFAULT_AUTH_FILE) {
    this.dataPath = dataPath;
    this.data = this.load();
  }

  private load(): AuthData {
    if (!existsSync(this.dataPath)) return { users: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.dataPath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || typeof parsed.users !== "object") {
        throw new Error("auth file root must be { users: {...} }");
      }
      return parsed as AuthData;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to parse auth file ${this.dataPath}: ${msg}`);
    }
  }

  private save(): void {
    const dir = dirname(this.dataPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  /**
   * Full SHA-256 fingerprint (hex) of a token for safe storage.
   * Full digest preserves all 256 bits of preimage resistance.
   */
  fingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /**
   * Add a new user. Returns a random API token (save this!).
   */
  async addUser(username: string, password: string): Promise<string> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const token = randomBytes(32).toString("hex");
    const fp = this.fingerprint(token);

    this.data.users[username] = { passwordHash, tokenFingerprints: [fp] };
    this.save();
    return token;
  }

  /**
   * Verify username + password.
   */
  async verifyCredentials(username: string, password: string): Promise<boolean> {
    const user = this.data.users[username];
    if (!user) return false;
    return bcrypt.compare(password, user.passwordHash);
  }

  /**
   * Verify an API token. Constant-time comparison on the full fingerprint.
   */
  verifyToken(token: string): boolean {
    const candidate = Buffer.from(this.fingerprint(token), "hex");
    for (const u of Object.values(this.data.users)) {
      for (const storedHex of u.tokenFingerprints) {
        const stored = Buffer.from(storedHex, "hex");
        if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
          return true;
        }
      }
    }
    return false;
  }

  listUsers(): string[] {
    return Object.keys(this.data.users);
  }

  deleteUser(username: string): boolean {
    if (!this.data.users[username]) return false;
    delete this.data.users[username];
    this.save();
    return true;
  }
}
