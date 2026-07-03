#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * WShell Server Daemon - Start (thin entry, delegates to server.ts).
 *
 * Usage:
 *   wshelld start                      Start daemon
 *   wshelld start -P 8080              Start on custom port
 *   wshelld start -r /home/user        Start with sandbox root
 */

import { TunnelServer } from "../server/index.js";
import { DEFAULT_AUTH_FILE } from "../shared/auth.js";

function banner() {
  console.log();
  console.log("  ┌──────────────────────────────────┐");
  console.log("  │        WShell Daemon              │");
  console.log("  │   encrypted · stable · fast       │");
  console.log("  └──────────────────────────────────┘");
  console.log();
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-P" || a === "--port") flags.port = args[++i];
    else if (a === "-H" || a === "--host") flags.host = args[++i];
    else if (a === "-a" || a === "--auth") flags.auth = args[++i];
    else if (a === "-r" || a === "--root") flags.root = args[++i];
    else if (a === "-m" || a === "--max-conn") flags.maxConn = args[++i];
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

banner();

new TunnelServer({
  port: flags.port ? parseInt(flags.port, 10) : 7700,
  host: flags.host || "0.0.0.0",
  authFile: flags.auth || DEFAULT_AUTH_FILE,
  rootDir: flags.root,
  maxConnections: flags.maxConn ? parseInt(flags.maxConn, 10) : 64,
});
