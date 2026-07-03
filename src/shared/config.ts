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
import { dirname, join } from "path";
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

/** Default config directory: ~/.wshell */
export const CONFIG_DIR = join(homedir(), ".wshell");
/** Default config file: ~/.wshell/config.json */
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS: WShellConfig = { hosts: {} };

export class Config {
  private data: WShellConfig;
  private path: string;

  constructor(path?: string) {
    this.path = path || CONFIG_FILE;
    this.data = this.load();
  }

  private load(): WShellConfig {
    if (!existsSync(this.path)) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("config root is not an object");
      }
      // Coerce shape defensively: only keep known host fields.
      const hosts: Record<string, HostConfig> = {};
      if (parsed.hosts && typeof parsed.hosts === "object") {
        for (const [name, h] of Object.entries(parsed.hosts)) {
          if (h && typeof h === "object") {
            const hc = h as Partial<HostConfig>;
            hosts[name] = {
              host: String(hc.host ?? ""),
              port: Number(hc.port) || 0,
              user: String(hc.user ?? ""),
              token: String(hc.token ?? ""),
            };
          }
        }
      }
      return { hosts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to parse config ${this.path}: ${msg}\n  Back it up and remove it to reset.`,
      );
    }
  }

  save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
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
