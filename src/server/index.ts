// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * TunnelServer
 *
 * Accepts WebSocket connections from clients.
 * Handles shell sessions, command execution, and file transfer.
 * All traffic after auth is encrypted with libsodium.
 */

import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { Socket } from "net";
import { ChildProcess, spawn, exec as execCb } from "child_process";
import {
  createWriteStream,
  existsSync,
  statSync,
  createReadStream,
  WriteStream,
} from "fs";
import { randomUUID } from "crypto";
import { Authenticator } from "../shared/auth.js";
import { createMessage, Message } from "../shared/protocol.js";
import {
  initCrypto,
  deriveKey,
  encrypt,
  decrypt,
} from "../crypto/index.js";

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface ServerConfig {
  port: number;
  host: string;
  authFile: string;
  heartbeatMs: number;
  sessionTimeoutMs: number;
  maxShells: number;
}

interface ShellSession {
  id: string;
  proc: ChildProcess;
  createdAt: number;
  lastActivity: number;
}

interface ClientConn {
  ws: WebSocket;
  id: string;
  ip: string;
  authenticated: boolean;
  encKey: Buffer | null;
  shells: Map<string, ShellSession>;
  uploadStreams: Map<string, WriteStream>;
}

/* ─── Defaults ───────────────────────────────────────────────────────── */

const DEFAULTS: ServerConfig = {
  port: 7700,
  host: "0.0.0.0",
  authFile: "wshell-auth.json",
  heartbeatMs: 15_000,
  sessionTimeoutMs: 3_600_000,
  maxShells: 10,
};

/* ─── Server ─────────────────────────────────────────────────────────── */

export class TunnelServer {
  private wss: WebSocketServer;
  private clients = new Map<string, ClientConn>();
  private auth: Authenticator;
  private cfg: ServerConfig;
  private pingTimer: ReturnType<typeof setInterval>;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: Partial<ServerConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.auth = new Authenticator(this.cfg.authFile);

    this.wss = new WebSocketServer({
      port: this.cfg.port,
      host: this.cfg.host,
    });

    this.wss.on("connection", (ws, req) => this.onConnect(ws, req));

    this.pingTimer = setInterval(() => this.heartbeat(), this.cfg.heartbeatMs);
    this.cleanupTimer = setInterval(
      () => this.cleanupStaleSessions(),
      60_000,
    );

    this.banner();
  }

  /* ── Connection lifecycle ──────────────────────────────────────────── */

  private async onConnect(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const ip = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
    const id = randomUUID();

    const client: ClientConn = {
      ws,
      id,
      ip,
      authenticated: false,
      encKey: null,
      shells: new Map(),
      uploadStreams: new Map(),
    };
    this.clients.set(id, client);
    this.log(`connection from ${ip} (${id})`);

    ws.on("message", async (raw) => {
      try {
        // Convert RawData to Buffer for uniform handling
        const buf = Buffer.isBuffer(raw) ? raw
          : Array.isArray(raw) ? Buffer.concat(raw)
          : Buffer.from(raw);

        // Decrypt if encrypted, otherwise parse as plaintext
        let msgStr: string;
        if (client.encKey && buf[0] === 0x00) {
          // First byte 0x00 = encrypted
          const decrypted = decrypt(
            buf.subarray(1),
            client.encKey,
          );
          if (!decrypted) {
            this.log(`decryption failed from ${id}`);
            return;
          }
          msgStr = decrypted;
        } else {
          msgStr = buf.toString("utf-8");
        }

        const msg = JSON.parse(msgStr);
        await this.onMessage(client, msg);
      } catch (e: any) {
        this.send(client, createMessage("error", { message: e.message }));
      }
    });

    ws.on("close", () => {
      this.log(`disconnected: ${id}`);
      this.cleanupClient(client);
      this.clients.delete(id);
    });

    ws.on("error", (err) => {
      this.log(`error ${id}: ${err.message}`);
    });

    // Auth timeout: 10 seconds
    setTimeout(() => {
      if (!client.authenticated) {
        this.send(client, createMessage("error", { message: "Auth timeout" }));
        ws.close();
      }
    }, 10_000);
  }

  /* ── Message routing ───────────────────────────────────────────────── */

  private async onMessage(client: ClientConn, msg: Message): Promise<void> {
    // Unauthenticated clients can only send "auth"
    if (!client.authenticated) {
      if (msg.type === "auth") return this.handleAuth(client, msg);
      this.send(client, createMessage("error", { message: "Not authenticated" }));
      return;
    }

    switch (msg.type) {
      case "shell_open":    return this.handleShellOpen(client, msg);
      case "shell_data":    return this.handleShellData(client, msg);
      case "shell_resize":  return this.handleShellResize(client, msg);
      case "shell_close":   return this.handleShellClose(client, msg);
      case "exec":          return this.handleExec(client, msg);
      case "file_upload":   return this.handleFileUpload(client, msg);
      case "file_download": return this.handleFileDownload(client, msg);
      case "pong":          return; // heartbeat ack
      default:
        this.send(client, createMessage("error", { message: `Unknown: ${msg.type}` }));
    }
  }

  /* ── Auth ──────────────────────────────────────────────────────────── */

  private handleAuth(client: ClientConn, msg: Message): void {
    const { token } = msg.payload as { token?: string };
    if (!token || !this.auth.verifyToken(token)) {
      this.send(client, createMessage("auth_result", { success: false, error: "Invalid token" }));
      return;
    }

    // Send auth_result BEFORE setting encKey (plaintext)
    this.send(client, createMessage("auth_result", { success: true }));

    client.authenticated = true;
    client.encKey = deriveKey(token);

    this.log(`authenticated: ${client.id}`);
  }

  /* ── Shell sessions ────────────────────────────────────────────────── */

  private handleShellOpen(client: ClientConn, msg: Message): void {
    if (client.shells.size >= this.cfg.maxShells) {
      this.send(client, createMessage("error", { message: "Max shells reached" }, msg.id));
      return;
    }

    const { cols = 80, rows = 24 } = msg.payload as { cols?: number; rows?: number };
    const sessionId = randomUUID();
    const shellPath = process.env.SHELL || "/bin/bash";

    const proc = spawn(shellPath, [], {
      env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
    });

    const session: ShellSession = {
      id: sessionId,
      proc,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    client.shells.set(sessionId, session);

    // Forward stdout/stderr to client
    proc.stdout?.on("data", (data: Buffer) => {
      session.lastActivity = Date.now();
      this.send(client, createMessage("shell_data", { sessionId, data: data.toString("utf-8") }));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      session.lastActivity = Date.now();
      this.send(client, createMessage("shell_data", { sessionId, data: data.toString("utf-8") }));
    });

    proc.on("close", (code) => {
      this.send(client, createMessage("shell_data", { sessionId, data: `\r\n[exit ${code}]\r\n` }));
      this.send(client, createMessage("shell_closed", { sessionId, code }));
      client.shells.delete(sessionId);
    });

    proc.on("error", (err) => {
      this.send(client, createMessage("shell_data", { sessionId, data: `\r\n[error: ${err.message}]\r\n` }));
      client.shells.delete(sessionId);
    });

    this.log(`shell opened: ${sessionId}`);
    this.send(client, createMessage("shell_opened", { sessionId }, msg.id));
  }

  private handleShellData(client: ClientConn, msg: Message): void {
    const { sessionId, data } = msg.payload as { sessionId: string; data: string };
    const session = client.shells.get(sessionId);
    if (session?.proc.stdin?.writable) {
      session.lastActivity = Date.now();
      session.proc.stdin.write(data);
    }
  }

  private handleShellResize(client: ClientConn, msg: Message): void {
    // TODO: integrate node-pty for proper PTY resize support
  }

  private handleShellClose(client: ClientConn, msg: Message): void {
    const { sessionId } = msg.payload as { sessionId: string };
    const session = client.shells.get(sessionId);
    if (session) {
      try { session.proc.kill(); } catch {}
      client.shells.delete(sessionId);
    }
  }

  /* ── Command execution ─────────────────────────────────────────────── */

  private handleExec(client: ClientConn, msg: Message): void {
    const { command, timeout = 30_000 } = msg.payload as { command: string; timeout?: number };

    execCb(command, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      this.send(client, createMessage("exec_result", {
        requestId: msg.id,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: error?.code ?? 0,
      }));
    });
  }

  /* ── File transfer ─────────────────────────────────────────────────── */

  private handleFileUpload(client: ClientConn, msg: Message): void {
    const { remotePath, data, chunkIndex, done } = msg.payload as {
      remotePath: string; data?: string; chunkIndex: number; done: boolean;
    };
    if (!data) return;

    const buffer = Buffer.from(data, "base64");

    if (chunkIndex === 0) {
      const ws = createWriteStream(remotePath);
      ws.write(buffer);
      client.uploadStreams.set(remotePath, ws);
    } else {
      client.uploadStreams.get(remotePath)?.write(buffer);
    }

    if (done) {
      client.uploadStreams.get(remotePath)?.end();
      client.uploadStreams.delete(remotePath);
      this.send(client, createMessage("upload_done", { remotePath, success: true }));
    }
  }

  private handleFileDownload(client: ClientConn, msg: Message): void {
    const { remotePath, chunkSize = 65_536 } = msg.payload as { remotePath: string; chunkSize?: number };

    if (!existsSync(remotePath)) {
      this.send(client, createMessage("error", { message: `Not found: ${remotePath}` }, msg.id));
      return;
    }

    const stat = statSync(remotePath);
    const total = Math.ceil(stat.size / chunkSize);
    const stream = createReadStream(remotePath, { highWaterMark: chunkSize });
    let idx = 0;

    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      idx++;
      this.send(client, createMessage("file_chunk", {
        remotePath, data: buf.toString("base64"), chunkIndex: idx - 1, totalChunks: total, done: idx === total,
      }));
    });

    stream.on("end", () => {
      // If file is empty, send a single done chunk
      if (idx === 0) {
        this.send(client, createMessage("file_chunk", {
          remotePath, data: "", chunkIndex: 0, totalChunks: 0, done: true,
        }));
      }
    });
  }

  /* ── Housekeeping ──────────────────────────────────────────────────── */

  private cleanupClient(client: ClientConn): void {
    for (const [, s] of client.shells) { try { s.proc.kill(); } catch {} }
    client.shells.clear();
    for (const [, ws] of client.uploadStreams) { try { ws.end(); } catch {} }
    client.uploadStreams.clear();
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [, client] of this.clients) {
      for (const [id, s] of client.shells) {
        if (now - s.lastActivity > this.cfg.sessionTimeoutMs) {
          this.log(`session timeout: ${id}`);
          try { s.proc.kill(); } catch {}
          client.shells.delete(id);
        }
      }
    }
  }

  private heartbeat(): void {
    for (const [, c] of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        this.send(c, createMessage("ping", {}));
      }
    }
  }

  /* ── Send (with encryption) ────────────────────────────────────────── */

  private send(client: ClientConn, msg: Message): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);

    if (client.encKey) {
      // Encrypted: first byte 0x00, then encrypted payload
      const packed = encrypt(json, client.encKey);
      const wire = Buffer.alloc(1 + packed.length);
      wire[0] = 0x00; // encryption flag
      packed.copy(wire, 1);
      client.ws.send(wire);
    } else {
      client.ws.send(json);
    }
  }

  /* ── CLI banner ────────────────────────────────────────────────────── */

  private banner(): void {
    console.log();
    console.log("  ┌──────────────────────────────────┐");
    console.log("  │         WShell Server             │");
    console.log("  │   encrypted · stable · fast       │");
    console.log("  └──────────────────────────────────┘");
    console.log();
    console.log(`  Listening on ${this.cfg.host}:${this.cfg.port}`);
    console.log(`  Auth file:    ${this.cfg.authFile}`);
    console.log();
  }

  private log(msg: string): void {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  close(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.cleanupTimer);
    for (const [, c] of this.clients) this.cleanupClient(c);
    this.wss.close();
  }
}
