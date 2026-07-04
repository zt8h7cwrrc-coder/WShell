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
import { createWriteStream, existsSync, statSync, createReadStream, readFileSync } from "fs";
import { resolve as resolvePath, isAbsolute, relative as relativePath } from "path";
import { randomUUID, createHash } from "crypto";
import { Authenticator, DEFAULT_AUTH_FILE } from "../shared/auth.js";
import {
  createMessage,
  asMessage,
  Msg,
  type Message,
  type BatchFileSpec,
  type BatchFileResult,
} from "../shared/protocol.js";
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
  /** Active batch upload sessions, keyed by batchId. */
  batchUploads: Map<
    string,
    {
      specs: BatchFileSpec[];
      /** Per fileIndex: write stream + rolling hash + byte count. */
      writers: Map<number, { stream: WriteStream; hash: ReturnType<typeof createHash>; bytes: number }>;
      results: BatchFileResult[];
    }
  >;
}

/** Compute SHA-256 hex of a file on disk. */
function hashFileSync(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
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
      batchUploads: new Map(),
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
      case Msg.BatchUpload:
        return this.handleBatchUploadStart(client, msg);
      case Msg.BatchDownload:
        return this.handleBatchDownload(client, msg);
      case Msg.BatchData:
        return this.handleBatchData(client, msg);
      case Msg.Pong:
        return; // heartbeat ack
      case Msg.Ping:
        // Protocol is server-initiated ping → client pong. Tolerate an
        // inbound ping (e.g. from an older client) instead of erroring.
        return;
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

  /* ── Batch transfer ────────────────────────────────────────────────── */
  //
  // One handshake per batch, not per file. The client declares the whole
  // manifest up front (path + size + sha256 for each file); we open all
  // write streams, then chunks for every file stream in as BatchData
  // messages with no per-file ack. When the client signals the last chunk
  // of a file (isLastOfFile), we close that stream and verify the rolling
  // hash against the declared sha256. A single BatchResult at the end
  // reports per-file success — one round trip for the whole batch.

  private handleBatchUploadStart(client: ClientConn, msg: Message): void {
    const { batchId, files } = msg.payload as {
      batchId: string;
      files: BatchFileSpec[];
    };

    if (!batchId || !Array.isArray(files) || files.length === 0) {
      this.sendError(client, "Invalid batch manifest", msg.id);
      return;
    }

    // Pre-validate every path and reject the whole batch if any is unsafe.
    // This keeps "one handshake = atomic batch" semantics: either all
    // files are accepted and streamed, or none.
    const resolved: { spec: BatchFileSpec; abs: string }[] = [];
    for (const spec of files) {
      const safe = this.resolveSafePath(spec.remotePath);
      if (!safe) {
        this.send(
          client,
          createMessage(Msg.BatchResult, {
            batchId,
            results: files.map((f) => ({
              fileIndex: f.index,
              remotePath: f.remotePath,
              success: false,
              error: "Path not allowed",
            })),
          }),
        );
        return;
      }
      resolved.push({ spec, abs: safe });
    }

    const writers = new Map<number, { stream: WriteStream; hash: ReturnType<typeof createHash>; bytes: number }>();
    for (const { spec, abs } of resolved) {
      try {
        const stream = createWriteStream(abs);
        writers.set(spec.index, { stream, hash: createHash("sha256"), bytes: 0 });
      } catch (e) {
        // Couldn't open one file — abort the batch, report all as failed.
        for (const w of writers.values()) w.stream.destroy();
        this.send(
          client,
          createMessage(Msg.BatchResult, {
            batchId,
            results: files.map((f) => ({
              fileIndex: f.index,
              remotePath: f.remotePath,
              success: false,
              error: "Failed to open for write",
            })),
          }),
        );
        return;
      }
    }

    client.batchUploads.set(batchId, { specs: files, writers, results: [] });
  }

  private handleBatchData(client: ClientConn, msg: Message): void {
    const { batchId, fileIndex, data, chunkIndex, isLastOfFile, sha256 } = msg.payload as {
      batchId: string;
      fileIndex: number;
      data: string;
      chunkIndex: number;
      isLastOfFile: boolean;
      sha256?: string;
    };

    const batch = client.batchUploads.get(batchId);
    if (!batch) return; // stale/unknown batch — drop silently
    const entry = batch.writers.get(fileIndex);
    if (!entry) return;

    if (data) {
      const buf = Buffer.from(data, "base64");
      entry.bytes += buf.length;
      if (entry.bytes > UPLOAD_MAX_BYTES) {
        entry.stream.destroy();
        batch.writers.delete(fileIndex);
        batch.results.push({
          fileIndex,
          remotePath: batch.specs.find((s) => s.index === fileIndex)?.remotePath ?? "",
          success: false,
          error: "File too large",
        });
        return;
      }
      entry.stream.write(buf);
      entry.hash.update(buf);
    }

    if (isLastOfFile) {
      entry.stream.end();
      batch.writers.delete(fileIndex);
      const spec = batch.specs.find((s) => s.index === fileIndex);
      const actual = entry.hash.digest("hex");
      const expected = sha256 ?? spec?.sha256;
      const ok = expected === actual;
      batch.results.push({
        fileIndex,
        remotePath: spec?.remotePath ?? "",
        success: ok,
        sha256Ok: ok,
        error: ok ? undefined : "sha256 mismatch",
      });

      // When the last file is verified, send the single result message and
      // tear down the batch session.
      if (batch.results.length === batch.specs.length) {
        this.send(client, createMessage(Msg.BatchResult, { batchId, results: batch.results }));
        client.batchUploads.delete(batchId);
      }
    }
  }

  private handleBatchDownload(client: ClientConn, msg: Message): void {
    const { batchId, files, chunkSize = DOWNLOAD_CHUNK } = msg.payload as {
      batchId: string;
      files: string[];
      chunkSize?: number;
    };

    if (!batchId || !Array.isArray(files) || files.length === 0) {
      this.sendError(client, "Invalid batch download request", msg.id);
      return;
    }

    // Pre-resolve + hash every file, then stream them all back-to-back.
    // Hashing happens before sending so each file's sha256 travels on its
    // last chunk, letting the client verify without a separate handshake.
    const manifest: { index: number; remotePath: string; abs: string; sha256: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const safe = this.resolveSafePath(files[i]);
      if (!safe || !existsSync(safe)) {
        // Send an empty error-marker chunk for this file so the client's
        // per-file handler can record the failure.
        this.send(
          client,
          createMessage(Msg.BatchData, {
            batchId,
            fileIndex: i,
            data: "",
            chunkIndex: 0,
            isLastOfFile: true,
            sha256: "",
          }),
        );
        continue;
      }
      manifest.push({ index: i, remotePath: files[i], abs: safe, sha256: hashFileSync(safe) });
    }

    // Stream each file's chunks sequentially. Backpressure: pause the read
    // stream if the WS buffer saturates, resume on 'drain'.
    let fileCursor = 0;
    /** The currently-active read stream, for pause/resume from the drain handler. */
    let active: { rs: ReturnType<typeof createReadStream>; paused: boolean } | null = null;

    const drainHandler = () => {
      if (active && active.paused && client.ws.bufferedAmount < 1 * 1024 * 1024) {
        active.paused = false;
        active.rs.resume();
      }
    };
    client.ws.on("drain", drainHandler);

    const streamFile = () => {
      if (fileCursor >= manifest.length) {
        client.ws.removeListener("drain", drainHandler);
        return; // batch complete — client verifies locally from sha256 fields
      }
      const f = manifest[fileCursor++];
      const rs = createReadStream(f.abs, { highWaterMark: chunkSize });
      active = { rs, paused: false };
      let idx = 0;
      rs.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        idx++;
        this.send(
          client,
          createMessage(Msg.BatchData, {
            batchId,
            fileIndex: f.index,
            data: buf.toString("base64"),
            chunkIndex: idx - 1,
            isLastOfFile: false,
          }),
        );
        if (client.ws.bufferedAmount > 4 * 1024 * 1024) {
          active!.paused = true;
          rs.pause();
        }
      });
      rs.on("end", () => {
        // Last chunk for this file carries the hash.
        this.send(
          client,
          createMessage(Msg.BatchData, {
            batchId,
            fileIndex: f.index,
            data: "",
            chunkIndex: idx,
            isLastOfFile: true,
            sha256: f.sha256,
          }),
        );
        streamFile(); // next file
      });
      rs.on("error", () => {
        this.send(
          client,
          createMessage(Msg.BatchData, {
            batchId,
            fileIndex: f.index,
            data: "",
            chunkIndex: 0,
            isLastOfFile: true,
            sha256: "",
          }),
        );
        streamFile();
      });
    };
    streamFile();
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
    for (const [, b] of client.batchUploads) {
      for (const w of b.writers.values()) {
        try {
          w.stream.destroy();
        } catch {
          /* ignore */
        }
      }
    }
    client.batchUploads.clear();
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
