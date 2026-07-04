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

import { TunnelClient } from "../client/index.js";
import { Config, type HostConfig } from "../shared/config.js";
import { randomBytes } from "crypto";
import { basename } from "path";
import { fatal } from "./util.js";

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function banner() {
  console.log();
  console.log("  ┌──────────────────────────────────┐");
  console.log("  │           WShell                 │");
  console.log("  │   encrypted · stable · fast       │");
  console.log("  └──────────────────────────────────┘");
  console.log();
}

function showHelp() {
  console.log(`
  Usage (SSH-style):
    wshell <user@host>                    Interactive shell (drops into remote terminal)
    wshell <user@host> exec <command>     Run one command, print output, exit
    wshell <user@host> put <local...> <remote>   Upload file(s) — multiple = batch into a dir
    wshell <user@host> get <remote...> <local-dir>  Download file(s) — batch with hash verify
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

  Batch transfer: 'put a b c /dir/' uploads all three files in one handshake
  with SHA-256 verification — far faster than per-file transfers for many
  small files. Single-file 'put a /dir/a' uses the same fast path.

  In an interactive shell, you're talking directly to the remote PTY —
  Ctrl-C, Ctrl-D, vim, top, sudo all work just like ssh. Type "exit" on
  the remote side (or close the terminal) to leave.
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

function resolveTarget(
  target: string,
  portFlag?: number,
  tokenFlag?: string,
  serverFlag?: string,
): HostConfig {
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
      port = portFlag || (url.port ? parseInt(url.port, 10) : port);
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

/* ─── Raw mode safety ─────────────────────────────────────────────────── */

function enterRawMode(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
}

function leaveRawMode(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
}

/* ─── One-shot connect helper ─────────────────────────────────────────── */

async function connectOnce(target: HostConfig): Promise<TunnelClient> {
  const client = new TunnelClient({
    server: `ws://${target.host}:${target.port}`,
    token: target.token,
  });
  await client.connect();
  return client;
}

/* ─── Interactive shell (SSH-style: drop straight into the remote terminal) */

async function cmdShell(target: HostConfig) {
  if (!target.token) {
    fatal(`No token for ${target.user}@${target.host}\n  Add token in ~/.wshell/config.json`);
  }

  const client = new TunnelClient({
    server: `ws://${target.host}:${target.port}`,
    token: target.token,
  });

  let currentSession: string | null = null;
  let exited = false;

  // Restore terminal state on any exit path.
  const cleanup = () => {
    leaveRawMode();
    client.close();
  };
  // SIGINT/SIGTERM only fire from outside raw mode (e.g. `kill`, or Ctrl-C
  // before the shell opens). Once we're in raw mode, Ctrl-C is delivered to
  // the remote PTY as 0x03 — exactly like ssh.
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  client.onShellOutput(
    (_id, data) => process.stdout.write(data),
    (_id, info) => {
      // Remote shell exited → leave the client, like ssh does.
      currentSession = null;
      leaveRawMode();
      if (exited) return;
      exited = true;
      console.log(
        `\n[shell closed · exit ${info.exitCode}${info.signal ? ` (${info.signal})` : ""}]`,
      );
      cleanup();
      process.exit(info.exitCode ?? 0);
    },
  );

  // Forward terminal resize events to the remote shell.
  process.stdout.on("resize", () => {
    if (currentSession) {
      client.resizeShell(currentSession, process.stdout.columns || 80, process.stdout.rows || 24);
    }
  });

  // Raw stdin passthrough: every byte goes to the remote PTY. No local
  // echo, no line editing, no slash commands — the remote shell owns the
  // terminal. This is what makes vim/top/sudo/Ctrl-C/Ctrl-D behave exactly
  // as they would over ssh.
  process.stdin.on("data", (data) => {
    if (!currentSession) return;
    client.sendShellData(currentSession, data.toString("utf-8"));
  });

  console.log(`  Connecting to ${target.user}@${target.host}:${target.port}...`);
  await client.connect();

  // Auto-open a remote PTY and enter raw passthrough immediately.
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  currentSession = await client.openShell(cols, rows);
  enterRawMode();
  process.stdin.resume();
  // No banner, no prompt, no "/shell" — we're in the remote terminal now.
}

/* ─── Direct exec ─────────────────────────────────────────────────────── */

async function cmdExec(target: HostConfig, command: string) {
  if (!target.token) fatal("No token configured");

  const client = await connectOnce(target);

  try {
    const result = await client.exec(command);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    client.close();
    process.exit(result.exitCode ?? 0);
  } catch (e) {
    client.close();
    fatal(e instanceof Error ? e.message : String(e));
  }
}

/* ─── Direct upload (single or batch) ─────────────────────────────────── */
//
// `wshell host put a b c /dir/`        → batch upload, remote names = a,b,c in /dir/
// `wshell host put a /dir/a`           → single file (batch of 1, fast path)
// Mirrors scp semantics: last arg is the remote destination. Multiple
// sources go into a remote directory.

async function cmdPut(target: HostConfig, paths: string[]) {
  if (!target.token) fatal("No token configured");
  if (paths.length < 2) fatal("Usage: wshell <host> put <local...> <remote>");

  const localFiles = paths.slice(0, -1);
  const remoteDest = paths[paths.length - 1];
  // If multiple sources, the destination is treated as a directory and each
  // file keeps its basename (like scp). A single source keeps the exact
  // remote path the user gave.
  const files =
    localFiles.length === 1
      ? [{ localPath: localFiles[0], remotePath: remoteDest }]
      : localFiles.map((lp) => ({
          localPath: lp,
          remotePath: remoteDest.replace(/\/$/, "") + "/" + basename(lp),
        }));

  const client = await connectOnce(target);
  try {
    const results = await client.uploadFiles(files);
    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r.success) {
        ok++;
        console.log(`  ✓ ${files[r.fileIndex].localPath} → ${target.host}:${r.remotePath}`);
      } else {
        fail++;
        console.error(`  ✗ ${files[r.fileIndex].localPath} → ${r.remotePath}: ${r.error ?? "failed"}`);
      }
    }
    client.close();
    console.log(`\n  Uploaded ${ok} file(s)${fail ? `, ${fail} failed` : ""}.`);
    if (fail) process.exit(1);
  } catch (e) {
    client.close();
    fatal(e instanceof Error ? e.message : String(e));
  }
}

/* ─── Direct download (single or batch) ───────────────────────────────── */

async function cmdGet(target: HostConfig, paths: string[]) {
  if (!target.token) fatal("No token configured");
  if (paths.length < 2) fatal("Usage: wshell <host> get <remote...> <local-dir>");

  const remoteFiles = paths.slice(0, -1);
  const localDir = paths[paths.length - 1];
  const files = remoteFiles.map((rp) => ({
    remotePath: rp,
    localPath: localDir.replace(/\/$/, "") + "/" + basename(rp),
  }));

  const client = await connectOnce(target);
  try {
    const results = await client.downloadFiles(files);
    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r.success) {
        ok++;
        console.log(`  ✓ ${target.host}:${r.remotePath} → ${files[r.fileIndex].localPath}`);
      } else {
        fail++;
        console.error(`  ✗ ${r.remotePath}: ${r.error ?? "failed"}`);
      }
    }
    client.close();
    console.log(`\n  Downloaded ${ok} file(s)${fail ? `, ${fail} failed` : ""}.`);
    if (fail) process.exit(1);
  } catch (e) {
    client.close();
    fatal(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
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
    if (rest.length < 3) fatal("Usage: wshell <host> put <local...> <remote>");
    await cmdPut(target, rest.slice(1));
    return;
  }

  if (sub === "get") {
    if (rest.length < 3) fatal("Usage: wshell <host> get <remote...> <local-dir>");
    await cmdGet(target, rest.slice(1));
    return;
  }

  fatal(`Unknown command: ${sub}\n  Run: wshell help`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
