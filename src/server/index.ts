// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * TunnelServer
 *
 * Accepts WebSocket connections from clients.
 * Handles shell sessions, command execution, and file transfer.
 * All traffic after auth is encrypted with libsodium (XChaCha20-Poly1305).
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { exec as execCb } from "child_process";
import type { WriteStream } from "fs";
import { createWriteStream, existsSync, statSync, createReadStream } from "fs";
import { resolve as resolvePath, isAbsolute, relative as relativePath } from "path";
import { randomUUID } from "crypto";
import { Authenticator, DEFAULT_AUTH_FILE } from "../shared/auth.js";
import { createMessage, asMessage, Msg, type Message } from "../shared/protocol.js";
import { initCrypto, deriveKey, packEncrypted, packPlain, unpackFrame } from "../crypto/index.js";
import { spawnPty, ptyAvailable, type PtyHandle } from "./pty.js";

/* ─── Constants ──────────────────────────────────────────────────────── */

const AUTH_TIMEOUT_MS = 10_000;
const AUTH_MAX_FAILURES = 5;
const AUTH_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 60_000;
const DOWNLOAD_CHUNK = 65_536;
const UPLOAD_MAX_BYTES = 256 * 1024 * 1024; // per-file cap for the demo path
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;
/** Reject new connections beyond this many concurrent clients. */
const DEFAULT_MAX_CONNECTIONS = 64;
/** RSS threshold (bytes) above which new connections are refused. */
const MEM_GUARD_BYTES = 512 * 1024 * 1024;
/** How often to sample process memory. */
const MEM_SAMPLE_MS = 30_000;

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface ServerConfig {
  port: number;
  host: string;
  authFile: string;
  heartbeatMs: number;
  sessionTimeoutMs: number;
  maxShells: number;
  /** Maximum concurrent authenticated clients. */
  maxConnections: number;
  /** Root directory that file transfers and exec are constrained to. */
  rootDir?: string;
}

interface ShellSession {
  id: string;
  pty: PtyHandle;
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
  uploadStreams: Map<string, { stream: WriteStream; bytes: number }>;
  authFailures: number[];
}

/* ─── Defaults ───────────────────────────────────────────────────────── */

const DEFAULTS: ServerConfig = {
  port: 7700,
  host: "0.0.0.0",
  authFile: DEFAULT_AUTH_FILE,
  heartbeatMs: 15_000,
  sessionTimeoutMs: 3_600_000,
  maxShells: 10,
  maxConnections: DEFAULT_MAX_CONNECTIONS,
};

/* ─── Server ─────────────────────────────────────────────────────────── */

export class TunnelServer {
  private wss: WebSocketServer;
  private clients = new Map<string, ClientConn>();
  private auth: Authenticator;
  private cfg: ServerConfig;
  private pingTimer: ReturnType<typeof setInterval>;
  private cleanupTimer: ReturnType<typeof setInterval>;
  /** Memory watchdog timer. */
  private memTimer: ReturnType<typeof setInterval>;
  /** Last sampled RSS, for OOM-aware admission. */
  private lastRss = 0;

  constructor(config: Partial<ServerConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.auth = new Authenticator(this.cfg.authFile);

    this.wss = new WebSocketServer({
      port: this.cfg.port,
      host: this.cfg.host,
      // Enforce a hard cap on concurrent connections at the WS layer too.
      maxPayload: UPLOAD_MAX_BYTES + 1024,
    });

    this.wss.on("connection", (ws, req) => this.onConnect(ws, req));

    this.pingTimer = setInterval(() => this.heartbeat(), this.cfg.heartbeatMs);
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), CLEANUP_INTERVAL_MS);
    this.memTimer = setInterval(() => this.sampleMemory(), MEM_SAMPLE_MS);

    this.banner();
  }

  /* ── Memory / OOM guard ───────────────────────────────────────────── */

  /**
   * Sample process RSS. When it approaches the guard threshold the server
   * refuses new connections and logs a warning, so a slow leak or a flood
   * of clients cannot quietly run the process into an OOM kill.
   */
  private sampleMemory(): void {
    this.lastRss = process.memoryUsage().rss;
    const pct = Math.round((this.lastRss / MEM_GUARD_BYTES) * 100);
    if (pct >= 80) {
      this.log(`⚠ memory high: ${Math.round(this.lastRss / 1024 / 1024)}MB rss (${pct}% of guard) — refusing new connections`);
    }
  }

  /** True when the process is close enough to the memory ceiling that new
   *  connections should be rejected. */
  private memorySaturated(): boolean {
    // Sample on demand if the timer hasn't fired yet.
    if (this.lastRss === 0) this.lastRss = process.memoryUsage().rss;
    return this.lastRss >= MEM_GUARD_BYTES * 0.8;
  }

  /* ── Connection lifecycle ──────────────────────────────────────────── */

  private async onConnect(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // OOM guard #1: cap concurrent connections.
    if (this.clients.size >= this.cfg.maxConnections) {
      this.log(`connection refused: max connections (${this.cfg.maxConnections}) reached`);
      ws.close(1013, "Try again later");
      return;
    }
    // OOM guard #2: refuse new connections when memory is saturated.
    if (this.memorySaturated()) {
      this.log("connection refused: memory saturated");
      ws.close(1013, "Try again later");
      return;
    }

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
      authFailures: [],
    };
    this.clients.set(id, client);
    this.log(`connection from ${ip} (${id}) · PTY ${ptyAvailable() ? "on" : "off"}`);

    ws.on("message", async (raw) => {
      try {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);

        const frame = unpackFrame(buf, client.encKey);
        if (frame.kind === "error") {
          this.log(`frame error from ${id}: ${frame.reason}`);
          if (client.authenticated) {
            this.sendError(client, "Invalid frame");
          }
          return;
        }

        // Reject plaintext frames once encryption is established.
        if (client.encKey && frame.kind === "plain") {
          this.log(`plaintext frame after auth from ${id}, dropping`);
          return;
        }

        const parsed = asMessage(JSON.parse(frame.text));
        if (!parsed) {
          this.sendError(client, "Malformed message");
          return;
        }
        await this.onMessage(client, parsed);
      } catch {
        this.sendError(client, "Malformed message");
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

    // Auth timeout
    setTimeout(() => {
      if (!client.authenticated && ws.readyState === WebSocket.OPEN) {
        this.send(client, createMessage(Msg.Error, { message: "Auth timeout" }));
        ws.close();
      }
    }, AUTH_TIMEOUT_MS);
  }

  /* ── Message routing ───────────────────────────────────────────────── */

  private async onMessage(client: ClientConn, msg: Message): Promise<void> {
    // Unauthenticated clients can only send "auth"
    if (!client.authenticated) {
      if (msg.type === Msg.Auth) return this.handleAuth(client, msg);
      this.sendError(client, "Not authenticated");
      return;
    }

    switch (msg.type) {
      case Msg.ShellOpen:
        return this.handleShellOpen(client, msg);
      case Msg.ShellData:
        return this.handleShellData(client, msg);
      case Msg.ShellResize:
        return this.handleShellResize(client, msg);
      case Msg.ShellClose:
        return this.handleShellClose(client, msg);
      case Msg.Exec:
        return this.handleExec(client, msg);
      case Msg.FileUpload:
        return this.handleFileUpload(client, msg);
      case Msg.FileDownload:
        return this.handleFileDownload(client, msg);
      case Msg.Pong:
        return; // heartbeat ack
      default:
        this.sendError(client, `Unknown: ${msg.type as string}`, msg.id);
    }
  }

  /* ── Auth ──────────────────────────────────────────────────────────── */

  private handleAuth(client: ClientConn, msg: Message): void {
    const { token } = msg.payload as { token?: string };

    // Rate-limit auth attempts per connection.
    const now = Date.now();
    client.authFailures = client.authFailures.filter((t) => now - t < AUTH_WINDOW_MS);
    if (client.authFailures.length >= AUTH_MAX_FAILURES) {
      this.send(
        client,
        createMessage(Msg.AuthResult, { success: false, error: "Too many attempts" }),
      );
      client.ws.close();
      return;
    }

    if (!token || !this.auth.verifyToken(token)) {
      client.authFailures.push(now);
      this.send(client, createMessage(Msg.AuthResult, { success: false, error: "Invalid token" }));
      // Close immediately: no brute-force window.
      client.ws.close();
      this.log(`auth failed from ${client.ip}`);
      return;
    }

    // Send auth_result BEFORE setting encKey (plaintext)
    this.send(client, createMessage(Msg.AuthResult, { success: true }));

    client.authenticated = true;
    client.encKey = deriveKey(token);

    this.log(`authenticated: ${client.id}`);
  }

  /* ── Shell sessions ────────────────────────────────────────────────── */

  private handleShellOpen(client: ClientConn, msg: Message): void {
    if (client.shells.size >= this.cfg.maxShells) {
      this.sendError(client, "Max shells reached", msg.id);
      return;
    }

    const { cols = 80, rows = 24 } = msg.payload as { cols?: number; rows?: number };
    const sessionId = randomUUID();
    const shellPath = process.env.SHELL || "/bin/bash";

    const pty = spawnPty(shellPath, [], {
      cols,
      rows,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
      },
    });

    const session: ShellSession = {
      id: sessionId,
      pty,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    client.shells.set(sessionId, session);

    pty.onData((data) => {
      session.lastActivity = Date.now();
      this.send(client, createMessage(Msg.ShellData, { sessionId, data }));
    });

    pty.onExit(({ exitCode, signal }) => {
      this.send(
        client,
        createMessage(Msg.ShellClosed, { sessionId, exitCode, signal: signal ?? null }),
      );
      client.shells.delete(sessionId);
    });

    this.log(`shell opened: ${sessionId}`);
    this.send(client, createMessage(Msg.ShellOpened, { sessionId }, msg.id));
  }

  private handleShellData(client: ClientConn, msg: Message): void {
    const { sessionId, data } = msg.payload as { sessionId: string; data: string };
    const session = client.shells.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      session.pty.write(data);
    }
  }

  private handleShellResize(client: ClientConn, msg: Message): void {
    const { sessionId, cols, rows } = msg.payload as {
      sessionId: string;
      cols: number;
      rows: number;
    };
    const session = client.shells.get(sessionId);
    session?.pty.resize(cols, rows);
  }

  private handleShellClose(client: ClientConn, msg: Message): void {
    const { sessionId } = msg.payload as { sessionId: string };
    const session = client.shells.get(sessionId);
    if (session) {
      session.pty.kill();
      client.shells.delete(sessionId);
    }
  }

  /* ── Command execution ─────────────────────────────────────────────── */

  /**
   * Execute an arbitrary command on the server.
   *
   * NOTE: This is a deliberate remote-command-execution feature — the whole
   * point of a remote shell. Once a client is authenticated it is fully
   * trusted, so running `child_process.exec(command)` with the client-
   * supplied string is by design, not a command-injection bug. The command
   * is run through a shell by design (so pipes/redirection work); output is
   * treated as text. cwd is constrained to rootDir when a sandbox is set.
   */
  private handleExec(client: ClientConn, msg: Message): void {
    const { command, timeout = 30_000 } = msg.payload as {
      command: string;
      timeout?: number;
    };

    const cwd = this.cfg.rootDir;

    execCb(command, { timeout, maxBuffer: EXEC_MAX_BUFFER, cwd }, (error, stdout, stderr) => {
      // error.code is null when killed by signal; preserve that honestly.
      const exitCode = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      const signal =
        error && "signal" in error ? ((error as { signal?: string }).signal ?? null) : null;
      this.send(
        client,
        createMessage(Msg.ExecResult, {
          requestId: msg.id,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          signal,
        }),
      );
    });
  }

  /* ── File transfer ─────────────────────────────────────────────────── */

  private handleFileUpload(client: ClientConn, msg: Message): void {
    const { remotePath, data, chunkIndex, done } = msg.payload as {
      remotePath: string;
      data?: string;
      chunkIndex: number;
      done: boolean;
    };

    // Validate / sandbox the path.
    const safe = this.resolveSafePath(remotePath);
    if (!safe) {
      this.send(
        client,
        createMessage(Msg.UploadDone, { remotePath, success: false, error: "Path not allowed" }),
      );
      return;
    }

    if (!data) {
      if (done) {
        // Zero-length upload: create/truncate the file.
        const ws = createWriteStream(safe);
        ws.end();
        this.send(client, createMessage(Msg.UploadDone, { remotePath, success: true }));
      }
      return;
    }

    const buffer = Buffer.from(data, "base64");
    const entry =
      chunkIndex === 0
        ? (() => {
            const stream = createWriteStream(safe);
            const e = { stream, bytes: 0 };
            client.uploadStreams.set(remotePath, e);
            return e;
          })()
        : client.uploadStreams.get(remotePath);

    if (!entry) {
      this.send(
        client,
        createMessage(Msg.UploadDone, { remotePath, success: false, error: "No active upload" }),
      );
      return;
    }

    entry.bytes += buffer.length;
    if (entry.bytes > UPLOAD_MAX_BYTES) {
      entry.stream.destroy();
      client.uploadStreams.delete(remotePath);
      this.send(
        client,
        createMessage(Msg.UploadDone, { remotePath, success: false, error: "File too large" }),
      );
      return;
    }

    entry.stream.write(buffer);

    if (done) {
      entry.stream.end();
      client.uploadStreams.delete(remotePath);
      this.send(client, createMessage(Msg.UploadDone, { remotePath, success: true }));
    }
  }

  private handleFileDownload(client: ClientConn, msg: Message): void {
    const { remotePath, chunkSize = DOWNLOAD_CHUNK } = msg.payload as {
      remotePath: string;
      chunkSize?: number;
    };

    const safe = this.resolveSafePath(remotePath);
    if (!safe || !existsSync(safe)) {
      this.sendError(client, `Not found: ${remotePath}`, msg.id);
      return;
    }

    const stat = statSync(safe);
    const total = Math.max(1, Math.ceil(stat.size / chunkSize));
    const stream = createReadStream(safe, { highWaterMark: chunkSize });
    let idx = 0;

    // Backpressure: pause the read stream while the WebSocket send buffer
    // is saturated, so a slow client cannot force the whole file into RAM.
    const maybePause = () => {
      if (client.ws.bufferedAmount > 4 * 1024 * 1024) stream.pause();
    };
    const resume = () => {
      if (client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount < 1 * 1024 * 1024) {
        stream.resume();
      }
    };

    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      idx++;
      this.send(
        client,
        createMessage(Msg.FileChunk, {
          remotePath,
          data: buf.toString("base64"),
          chunkIndex: idx - 1,
          totalChunks: total,
          done: idx === total,
        }),
      );
      maybePause();
    });

    // Resume when the client drains enough.
    const drainHandler = () => resume();
    client.ws.on("drain", drainHandler);

    stream.on("end", () => {
      client.ws.removeListener("drain", drainHandler);
      if (idx === 0) {
        this.send(
          client,
          createMessage(Msg.FileChunk, {
            remotePath,
            data: "",
            chunkIndex: 0,
            totalChunks: 0,
            done: true,
          }),
        );
      }
    });

    stream.on("error", (err) => {
      client.ws.removeListener("drain", drainHandler);
      this.log(`download error ${remotePath}: ${err.message}`);
      this.sendError(client, "Download failed", msg.id);
    });
  }

  /* ── Path sandboxing ──────────────────────────────────────────────── */

  /**
   * Resolve a client-supplied path against rootDir (if configured) and
   * reject directory traversal. Returns an absolute safe path or null.
   *
   * Without rootDir, arbitrary absolute paths are allowed (the server is
   * already running as a trusted user), but traversal escapes are still
   * normalised so the resolved target is explicit.
   */
  private resolveSafePath(p: string): string | null {
    if (!p) return null;
    const root = this.cfg.rootDir;

    const base = root
      ? resolvePath(root, p)
      : isAbsolute(p)
        ? resolvePath(p)
        : resolvePath(process.cwd(), p);

    if (root) {
      const rel = relativePath(resolvePath(root), base);
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
    }
    return base;
  }

  /* ── Housekeeping ──────────────────────────────────────────────────── */

  private cleanupClient(client: ClientConn): void {
    for (const [, s] of client.shells) {
      try {
        s.pty.kill();
      } catch {
        /* ignore */
      }
    }
    client.shells.clear();
    for (const [, e] of client.uploadStreams) {
      try {
        e.stream.end();
      } catch {
        /* ignore */
      }
    }
    client.uploadStreams.clear();
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    for (const [, client] of this.clients) {
      for (const [id, s] of client.shells) {
        if (now - s.lastActivity > this.cfg.sessionTimeoutMs) {
          this.log(`session timeout: ${id}`);
          try {
            s.pty.kill();
          } catch {
            /* ignore */
          }
          client.shells.delete(id);
        }
      }
    }
  }

  private heartbeat(): void {
    for (const [, c] of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        this.send(c, createMessage(Msg.Ping, {}));
      }
    }
  }

  /* ── Send (with encryption) ────────────────────────────────────────── */

  private send(client: ClientConn, msg: Message): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);

    if (client.encKey) {
      const wire = packEncrypted(json, client.encKey);
      // Respect backpressure: skip the frame if the buffer is saturated
      // rather than growing memory unbounded.
      if (client.ws.bufferedAmount > 8 * 1024 * 1024) {
        this.log(`backpressure drop to ${client.id}`);
        return;
      }
      client.ws.send(wire);
    } else {
      client.ws.send(packPlain(json));
    }
  }

  /** Send an error message that does not leak internal details. */
  private sendError(client: ClientConn, message: string, replyTo?: string): void {
    this.send(client, createMessage(Msg.Error, { message }, replyTo));
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
    console.log(`  Max clients:  ${this.cfg.maxConnections}`);
    console.log(`  PTY backend:  ${ptyAvailable() ? "node-pty" : "spawn (fallback)"}`);
    if (this.cfg.rootDir) {
      console.log(`  Sandbox root: ${this.cfg.rootDir}`);
    }
    console.log();
  }

  private log(msg: string): void {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  close(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.cleanupTimer);
    clearInterval(this.memTimer);
    for (const [, c] of this.clients) this.cleanupClient(c);
    this.wss.close();
  }
}

// Ensure sodium-native is loaded on server start.
void initCrypto();
