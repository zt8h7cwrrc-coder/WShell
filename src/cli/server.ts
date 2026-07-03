#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * WShell Server Daemon (wshelld)
 *
 * Usage:
 *   wshelld start                                Start daemon
 *   wshelld user add <name> -p <password>        Add user
 *   wshelld user list                            List users
 *   wshelld user remove <name>                   Remove user
 *   wshelld help                                 Show help
 *
 * Options:
 *   -P, --port <port>     Listen port (default: 7700)
 *   -H, --host <host>     Listen address (default: 0.0.0.0)
 *   -a, --auth <file>     Auth file path (default: ~/.wshell/auth.json)
 *   -r, --root <dir>      Sandbox root for file transfers/exec cwd
 *   -m, --max-conn <n>    Max concurrent clients (default: 64)
 */

import { TunnelServer } from "../server/index.js";
import { Authenticator, DEFAULT_AUTH_FILE } from "../shared/auth.js";
import { fatal } from "./util.js";

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function banner() {
  console.log();
  console.log("  ┌──────────────────────────────────┐");
  console.log("  │        WShell Daemon              │");
  console.log("  │   encrypted · stable · fast       │");
  console.log("  └──────────────────────────────────┘");
  console.log();
}

function showHelp() {
  console.log(`
  Usage:
    wshelld start                                Start daemon
    wshelld user add <name> -p <password>        Add user
    wshelld user list                            List users
    wshelld user remove <name>                   Remove user
    wshelld help                                 Show this message

  Options:
    -P, --port <port>     Listen port (default: 7700)
    -H, --host <host>     Listen address (default: 0.0.0.0)
    -a, --auth <file>     Auth file (default: ~/.wshell/auth.json)
    -r, --root <dir>      Sandbox root for file transfers/exec cwd
`);
}

/* ─── Parse args ──────────────────────────────────────────────────────── */

interface ParsedArgs {
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-P" || arg === "--port") {
      flags.port = args[++i];
    } else if (arg === "-H" || arg === "--host") {
      flags.host = args[++i];
    } else if (arg === "-a" || arg === "--auth") {
      flags.auth = args[++i];
    } else if (arg === "-r" || arg === "--root") {
      flags.root = args[++i];
    } else if (arg === "-m" || arg === "--max-conn") {
      flags.maxConn = args[++i];
    } else if (arg === "-p" || arg === "--password") {
      flags.password = args[++i];
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/* ─── User commands ───────────────────────────────────────────────────── */

async function cmdUser(args: string[], flags: Record<string, string>) {
  const sub = args[0];
  const authFile = flags.auth || DEFAULT_AUTH_FILE;
  const auth = new Authenticator(authFile);

  if (sub === "add") {
    const name = args[1];
    const password = flags.password;
    if (!name) fatal("Usage: wshelld user add <name> -p <password>");
    if (!password) fatal("Password required: -p <password>");

    const token = await auth.addUser(name, password);
    console.log(`  User "${name}" created.`);
    console.log(`  Token: ${token}`);
    console.log();
    console.log("  Add this host to your client:");
    console.log(`    wshell config add myhost ${name}@<server-ip>`);
    console.log("  Then edit ~/.wshell/config.json to paste the token.");
    return;
  }

  if (sub === "list" || sub === "ls") {
    const users = auth.listUsers();
    if (users.length === 0) {
      console.log("  No users.");
      return;
    }
    console.log();
    for (const u of users) {
      console.log(`  - ${u}`);
    }
    console.log();
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = args[1];
    if (!name) fatal("Usage: wshelld user remove <name>");
    const ok = auth.deleteUser(name);
    console.log(ok ? `  User "${name}" removed.` : `  User "${name}" not found.`);
    return;
  }

  fatal(`Unknown user command: ${sub}\n  Run: wshelld help`);
}

/* ─── Start command ───────────────────────────────────────────────────── */

function cmdStart(flags: Record<string, string>) {
  new TunnelServer({
    port: flags.port ? parseInt(flags.port, 10) : 7700,
    host: flags.host || "0.0.0.0",
    authFile: flags.auth || DEFAULT_AUTH_FILE,
    rootDir: flags.root,
    maxConnections: flags.maxConn ? parseInt(flags.maxConn, 10) : 64,
  });
}

/* ─── Main ────────────────────────────────────────────────────────────── */

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (positional.length === 0 || positional[0] === "help" || positional[0] === "--help") {
    banner();
    showHelp();
    return;
  }

  const command = positional[0];

  if (command === "start") {
    banner();
    cmdStart(flags);
    return;
  }

  if (command === "user") {
    banner();
    await cmdUser(positional.slice(1), flags);
    return;
  }

  fatal(`Unknown command: ${command}\n  Run: wshelld help`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
