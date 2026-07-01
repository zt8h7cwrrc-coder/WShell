// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * Authentication Module
 *
 * Users are identified by username + password.
 * Passwords are hashed with bcrypt (10 rounds).
 * API access uses random tokens, stored as SHA-256 fingerprints.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";

interface StoredUser {
  passwordHash: string;
  tokenFingerprints: string[];
}

interface AuthData {
  users: Record<string, StoredUser>;
}

export class Authenticator {
  private dataPath: string;
  private data: AuthData;

  constructor(dataPath: string = "tunnel-auth.json") {
    this.dataPath = dataPath;
    this.data = this.load();
  }

  private load(): AuthData {
    if (existsSync(this.dataPath)) {
      return JSON.parse(readFileSync(this.dataPath, "utf-8"));
    }
    return { users: {} };
  }

  private save(): void {
    writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Generate a SHA-256 fingerprint of a token for safe storage.
   */
  fingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 16);
  }

  /**
   * Add a new user. Returns a random API token (save this!).
   */
  async addUser(username: string, password: string): Promise<string> {
    const passwordHash = await bcrypt.hash(password, 10);
    const token = randomBytes(32).toString("hex");
    const fp = this.fingerprint(token);

    this.data.users[username] = { passwordHash, tokenFingerprints: [fp] };
    this.save();
    return token;
  }

  /**
   * Verify username + password.
   */
  async verifyCredentials(
    username: string,
    password: string,
  ): Promise<boolean> {
    const user = this.data.users[username];
    if (!user) return false;
    return bcrypt.compare(password, user.passwordHash);
  }

  /**
   * Verify an API token.
   */
  verifyToken(token: string): boolean {
    const fp = this.fingerprint(token);
    return Object.values(this.data.users).some((u) =>
      u.tokenFingerprints.includes(fp),
    );
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
