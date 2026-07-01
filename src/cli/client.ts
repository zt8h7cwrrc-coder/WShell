#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * WShell Client CLI
 *
 * Usage:
 *   wshell user@host                          Interactive shell
 *   wshell user@host exec <command>           Execute command
 *   wshell user@host put <local> <remote>     Upload file
 *   wshell user@host get <remote> <local>     Download file
 *   wshell user@host:8080                     With port in host
 *   wshell user@host -P 8080                  With port flag
 *   wshell keygen                             Generate a token
 *   wshell config add <name> <user@host>      Add host to config
 *   wshell config remove <name>               Remove host
 *   wshell config list                        List saved hosts
 *   wshell help                               Show help
 */

import { TunnelClient, ClientConfig } from "../client/index.js";
import { Config, HostConfig } from "../shared/config.js";
import { createInterface, Interface } from "readline";
import { randomBytes } from "crypto";
import { join } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function banner() {
  console.log();
  console.log("  ┌──────────────────────────────────┐");
  console.log("  │           WShell                 │");
  console.log("  │   encrypted · stable · fast       │");
  console.log("  └──────────────────────────────────┘");
  console.log();
}

function fatal(msg: string): never {
  console.error(`wshell: ${msg}`);
  process.exit(1);
}

function showHelp() {
  console.log(`
  Usage:
    wshell <user@host>                    Interactive shell
    wshell <user@host> exec <command>     Execute a command
    wshell <user@host> put <lp> <rp>      Upload a file
    wshell <user@host> get <rp> <lp>      Download a file
    wshell <user@host:port>               With port in host string
    wshell <user@host> -P <port>          With port flag

  Config:
    wshell config add <name> <user@host>  Add a host
    wshell config remove <name>           Remove a host
    wshell config list                    List saved hosts

  Key:
    wshell keygen                         Generate a new token

  Help:
    wshell help                           Show this message
`);
}

/* ─── Keygen ──────────────────────────────────────────────────────────── */

function cmdKeygen() {
  const token = randomBytes(32).toString("hex");
  console.log();
  console.log("  Token generated:");
  console.log();
  console.log(`  ${token}`);
  console.log();
  console.log("  Use this with: wshell config add <name> <user@host>");
  console.log("  Then connect:  wshell <name>");
  console.log();
}

/* ─── Config commands ─────────────────────────────────────────────────── */

function cmdConfig(args: string[]) {
  const sub = args[0];
  const config = new Config();

  if (sub === "add") {
    const name = args[1];
    const target = args[2];
    if (!name || !target) fatal("Usage: wshell config add <name> <user@host[:port]>");

    const parsed = Config.parseTarget(target);
    if (!parsed.user) fatal("Must specify user: e.g. admin@1.2.3.4");

    config.addHost(name, {
      host: parsed.host,
      port: parsed.port || 7700,
      user: parsed.user,
      token: "", // User will need to set this manually or via keygen
    });
    console.log(`  Host "${name}" added.`);
    console.log(`  Edit ~/.wshell/config.json to set the token.`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = args[1];
    if (!name) fatal("Usage: wshell config remove <name>");
    const ok = config.removeHost(name);
    console.log(ok ? `  Host "${name}" removed.` : `  Host "${name}" not found.`);
    return;
  }

  if (sub === "list" || sub === "ls") {
    const hosts = config.listHosts();
    const names = Object.keys(hosts);
    if (names.length === 0) {
      console.log("  No hosts configured.");
      console.log("  Add one: wshell config add <name> <user@host>");
      return;
    }
    console.log();
    for (const name of names) {
      const h = hosts[name];
      console.log(`  ${name}`);
      console.log(`    user:  ${h.user}`);
      console.log(`    host:  ${h.host}`);
      console.log(`    port:  ${h.port}`);
      console.log(`    token: ${h.token ? h.token.slice(0, 8) + "..." : "(not set)"}`);
      console.log();
    }
    return;
  }

  fatal(`Unknown config command: ${sub}\n  Run: wshell help`);
}

/* ─── Resolve target ──────────────────────────────────────────────────── */

function resolveTarget(target: string, portFlag?: number, tokenFlag?: string, serverFlag?: string): HostConfig {
  const config = new Config();
  const parsed = Config.parseTarget(target);

  // Check if target is a saved host name
  const saved = config.getHost(target);
  if (saved) {
    return {
      ...saved,
      port: portFlag || saved.port,
      token: tokenFlag || saved.token,
      host: serverFlag ? new URL(serverFlag.replace(/^ws:\/\//, "http://")).hostname : saved.host,
    };
  }

  // Build from parsed target
  if (!parsed.user) fatal(`Invalid target: ${target}\n  Format: user@host[:port]`);

  let host = parsed.host;
  let port = portFlag || parsed.port || 7700;

  // If server flag is provided, extract host and port from it
  if (serverFlag) {
    try {
      const url = new URL(serverFlag.replace(/^ws:\/\//, "http://"));
      host = url.hostname;
      port = portFlag || url.port ? parseInt(url.port, 10) : port;
    } catch {
      // Use as-is
    }
  }

  return {
    user: parsed.user,
    host,
    port,
    token: tokenFlag || "",
  };
}

/* ─── Interactive shell ───────────────────────────────────────────────── */

async function cmdShell(target: HostConfig) {
  if (!target.token) {
    fatal(`No token for ${target.user}@${target.host}\n  Add token in ~/.wshell/config.json`);
  }

  const client = new TunnelClient({
    server: `ws://${target.host}:${target.port}`,
    token: target.token,
  });

  let currentSession: string | null = null;
  let rl: Interface | null = null;

  client.onShellOutput(
    (_id, data) => process.stdout.write(data),
    (_id) => {
      currentSession = null;
      console.log("\n[shell closed]");
      prompt();
    },
  );

  function prompt() {
    if (!rl || currentSession) return;
    rl.question(`\x1b[36m${target.user}@${target.host}>\x1b[0m `, async (answer) => {
      const cmd = answer.trim();
      if (!cmd) { prompt(); return; }
      try {
        await handleShellCmd(client, cmd, target);
      } catch (e: any) {
        console.log(`Error: ${e.message}`);
      }
      prompt();
    });
  }

  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on("data", (data) => {
    if (!currentSession) return;
    const str = data.toString("utf-8");
    if (str === "\x03" || str === "\x04") {
      if (currentSession) {
        client.closeShell(currentSession);
        currentSession = null;
        console.log("\n[shell closed]");
        prompt();
      }
      return;
    }
    client.sendShellData(currentSession, str);
  });

  await client.connect();
  console.log(`  Connecting to ${target.user}@${target.host}:${target.port}...`);
  console.log();

  setTimeout(() => {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log("  Commands: /shell, /exec, /put, /get, /quit");
    console.log();
    prompt();
  }, 1500);

  async function handleShellCmd(client: TunnelClient, cmd: string, target: HostConfig) {
    if (cmd === "/quit" || cmd === "/exit") { client.close(); process.exit(0); }

    if (cmd === "/shell") {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      currentSession = await client.openShell(cols, rows);
      console.log(`[shell ${currentSession}]`);
      return;
    }

    if (cmd.startsWith("/exec ")) {
      const result = await client.exec(cmd.slice(6));
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) console.log(`\n[exit ${result.exitCode}]`);
      return;
    }

    if (cmd.startsWith("/put ")) {
      const [lp, rp] = cmd.slice(5).split(/\s+/);
      if (!lp || !rp) { console.log("Usage: /put <local> <remote>"); return; }
      await client.uploadFile(lp, rp);
      console.log("Upload complete.");
      return;
    }

    if (cmd.startsWith("/get ")) {
      console.log("(download not yet implemented in this demo)");
      return;
    }

    console.log(`Unknown: ${cmd}`);
  }
}

/* ─── Direct exec ─────────────────────────────────────────────────────── */

async function cmdExec(target: HostConfig, command: string) {
  if (!target.token) fatal("No token configured");

  const client = new TunnelClient({
    server: `ws://${target.host}:${target.port}`,
    token: target.token,
  });

  await client.connect();
  await new Promise((r) => setTimeout(r, 1000));

  try {
    const result = await client.exec(command);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  } catch (e: any) {
    fatal(e.message);
  }
}

/* ─── Direct upload ───────────────────────────────────────────────────── */

async function cmdPut(target: HostConfig, local: string, remote: string) {
  if (!target.token) fatal("No token configured");

  const client = new TunnelClient({
    server: `ws://${target.host}:${target.port}`,
    token: target.token,
  });

  await client.connect();
  await new Promise((r) => setTimeout(r, 1000));

  try {
    await client.uploadFile(local, remote);
    console.log(`Uploaded ${local} → ${target.host}:${remote}`);
  } catch (e: any) {
    fatal(e.message);
  }
  client.close();
}

/* ─── Direct download ─────────────────────────────────────────────────── */

async function cmdGet(target: HostConfig, remote: string, local: string) {
  if (!target.token) fatal("No token configured");

  const client = new TunnelClient({
    server: `ws://${target.host}:${target.port}`,
    token: target.token,
  });

  try {
    await client.connect();
    await client.downloadFile(remote, local);
    console.log(`Downloaded ${target.host}:${remote} → ${local}`);
    client.close();
  } catch (e: any) {
    fatal(`Download failed: ${e.message}`);
  }
}

/* ─── Main ────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    banner();
    showHelp();
    return;
  }

  if (args[0] === "keygen") {
    banner();
    cmdKeygen();
    return;
  }

  if (args[0] === "config") {
    banner();
    cmdConfig(args.slice(1));
    return;
  }

  // Extract --token and --server flags from args
  let tokenFlag: string | undefined;
  let serverFlag: string | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && args[i + 1]) {
      tokenFlag = args[++i];
    } else if (args[i] === "--server" && args[i + 1]) {
      serverFlag = args[++i];
    } else if (args[i].startsWith("--token=")) {
      tokenFlag = args[i].slice(8);
    } else if (args[i].startsWith("--server=")) {
      serverFlag = args[i].slice(9);
    } else {
      filteredArgs.push(args[i]);
    }
  }

  // Parse target and subcommand
  const targetStr = filteredArgs[0];
  const rest = filteredArgs.slice(1);

  // Parse -P port flag
  let portFlag: number | undefined;
  const pIdx = rest.indexOf("-P");
  if (pIdx !== -1 && rest[pIdx + 1]) {
    portFlag = parseInt(rest[pIdx + 1], 10);
    rest.splice(pIdx, 2);
  }

  const target = resolveTarget(targetStr, portFlag, tokenFlag, serverFlag);
  banner();

  if (rest.length === 0) {
    // Interactive shell
    await cmdShell(target);
    return;
  }

  const sub = rest[0];

  if (sub === "exec") {
    await cmdExec(target, rest.slice(1).join(" "));
    return;
  }

  if (sub === "put") {
    if (!rest[1] || !rest[2]) fatal("Usage: wshell <host> put <local> <remote>");
    await cmdPut(target, rest[1], rest[2]);
    return;
  }

  if (sub === "get") {
    if (!rest[1] || !rest[2]) fatal("Usage: wshell <host> get <remote> <local>");
    await cmdGet(target, rest[1], rest[2]);
    return;
  }

  fatal(`Unknown command: ${sub}\n  Run: wshell help`);
}

main().catch(console.error);
