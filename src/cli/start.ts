#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * WShell Server Daemon - Start
 *
 * Usage:
 *   wshelld start                      Start daemon
 *   wshelld -P 8080                    Start on custom port
 */

import { TunnelServer } from "../server/index.js";

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
    if (args[i] === "-P" || args[i] === "--port") flags.port = args[++i];
    if (args[i] === "-H" || args[i] === "--host") flags.host = args[++i];
    if (args[i] === "-a" || args[i] === "--auth") flags.auth = args[++i];
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));

banner();

new TunnelServer({
  port: flags.port ? parseInt(flags.port, 10) : 7700,
  host: flags.host || "0.0.0.0",
  authFile: flags.auth || "wshell-auth.json",
});
