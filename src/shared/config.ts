// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * WShell Config
 *
 * ~/.wshell/config.json
 *
 * Example:
 * {
 *   "hosts": {
 *     "myserver": {
 *       "host": "1.2.3.4",
 *       "port": 7700,
 *       "user": "admin",
 *       "token": "xxxx..."
 *     }
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface HostConfig {
  host: string;
  port: number;
  user: string;
  token: string;
}

export interface WShellConfig {
  hosts: Record<string, HostConfig>;
}

const CONFIG_DIR = join(homedir(), ".wshell");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS: WShellConfig = { hosts: {} };

export class Config {
  private data: WShellConfig;
  private path: string;

  constructor(path?: string) {
    this.path = path || CONFIG_FILE;
    this.data = this.load();
  }

  private load(): WShellConfig {
    if (existsSync(this.path)) {
      return JSON.parse(readFileSync(this.path, "utf-8"));
    }
    return { ...DEFAULTS };
  }

  save(): void {
    const dir = join(this.path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  getHost(name: string): HostConfig | undefined {
    return this.data.hosts[name];
  }

  addHost(name: string, config: HostConfig): void {
    this.data.hosts[name] = config;
    this.save();
  }

  removeHost(name: string): boolean {
    if (!this.data.hosts[name]) return false;
    delete this.data.hosts[name];
    this.save();
    return true;
  }

  listHosts(): Record<string, HostConfig> {
    return { ...this.data.hosts };
  }

  /**
   * Parse "user@host:port" string.
   * Returns { user, host, port } where missing parts are undefined.
   */
  static parseTarget(target: string): {
    user?: string;
    host: string;
    port?: number;
  } {
    let user: string | undefined;
    let host = target;
    let port: number | undefined;

    // user@host
    const atIdx = host.indexOf("@");
    if (atIdx !== -1) {
      user = host.slice(0, atIdx);
      host = host.slice(atIdx + 1);
    }

    // host:port
    const colonIdx = host.indexOf(":");
    if (colonIdx !== -1) {
      port = parseInt(host.slice(colonIdx + 1), 10);
      host = host.slice(0, colonIdx);
    }

    return { user, host, port };
  }
}
