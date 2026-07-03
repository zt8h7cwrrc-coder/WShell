// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * TunnelClient
 *
 * Connects to a TunnelServer over WebSocket.
 * Features:
 *   - Automatic reconnection with exponential backoff
 *   - libsodium encryption after auth
 *   - Heartbeat to detect dead connections
 *   - Interactive shell, exec, file upload/download
 */

import WebSocket from "ws";
import { createWriteStream, existsSync, statSync, createReadStream } from "fs";
import {
  createMessage,
  asMessage,
  payload,
  Msg,
  type Message,
  type ExecResultPayload,
  type FileChunkPayload,
  type ShellDataPayload,
  type ShellClosedPayload,
} from "../shared/protocol.js";
import { initCrypto, deriveKey, packEncrypted, packPlain, unpackFrame } from "../crypto/index.js";

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface ClientConfig {
  server: string;
  token: string;
  heartbeatMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** Connection/auth timeout in ms. */
  connectTimeoutMs: number;
}

interface PendingRequest {
  resolve: (msg: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ShellDataHandler = (sessionId: string, data: string) => void;
type ShellClosedHandler = (sessionId: string, info: ShellClosedPayload) => void;
type FileChunkHandler = (msg: Message, payload: FileChunkPayload) => void;
type StatusHandler = (
  status: "connected" | "disconnected" | "reconnecting" | "auth_failed",
) => void;

/* ─── Defaults ───────────────────────────────────────────────────────── */

const DEFAULTS: ClientConfig = {
  server: "ws://localhost:7700",
  token: "",
  heartbeatMs: 20_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  connectTimeoutMs: 10_000,
};

const DOWNLOAD_CHUNK = 65_536;

/* ─── Client ─────────────────────────────────────────────────────────── */

export class TunnelClient {
  private ws: WebSocket | null = null;
  private cfg: ClientConfig;
  private encKey: Buffer | null = null;
  private pending = new Map<string, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay: number;
  private closed = false;
  private authedOnce = false;

  private onShellData?: ShellDataHandler;
  private onShellClosed?: ShellClosedHandler;
  private onStatus?: StatusHandler;
  /** Per-remotePath chunk handlers for active downloads. */
  private downloadHandlers = new Map<string, FileChunkHandler>();

  constructor(config: Partial<ClientConfig>) {
    this.cfg = { ...DEFAULTS, ...config };
    this.currentDelay = this.cfg.reconnectBaseMs;
  }

  /* ── Connection ────────────────────────────────────────────────────── */

  /**
   * Connect and authenticate. Resolves once auth_result(success) arrives,
   * or rejects on timeout/auth failure. No internal sleeps.
   */
  async connect(): Promise<void> {
    await initCrypto();
    this.closed = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const ws = new WebSocket(this.cfg.server);
      this.ws = ws;

      // Overall connect/auth timeout.
      const timeout = setTimeout(() => {
        if (!settled) fail(new Error("Connection timeout"));
      }, this.cfg.connectTimeoutMs);

      const clearTimer = () => clearTimeout(timeout);

      ws.on("open", () => {
        this.log("connected");
        this.currentDelay = this.cfg.reconnectBaseMs;
        this.authenticate();
      });

      ws.on("message", (raw) => {
        // First message is expected to be auth_result.
        const msg = this.tryParse(raw);
        if (!msg) return;
        if (!this.authedOnce && msg.type === Msg.AuthResult) {
          clearTimer();
          const { success, error } = payload<{ success: boolean; error?: string }>(msg);
          if (success) {
            this.encKey = deriveKey(this.cfg.token);
            this.authedOnce = true;
            this.onStatus?.("connected");
            this.startHeartbeat();
            ok();
          } else {
            this.onStatus?.("auth_failed");
            fail(new Error(`Authentication failed: ${error ?? "invalid token"}`));
          }
          return;
        }
        // Subsequent messages handled by the dispatcher.
        this.onMessage(msg);
      });

      ws.on("close", () => {
        clearTimer();
        this.log("disconnected");
        this.stopHeartbeat();
        this.encKey = null;
        this.rejectAllPending(new Error("Connection closed"));
        if (!settled) fail(new Error("Connection closed during auth"));
        if (!this.closed) {
          this.onStatus?.("disconnected");
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.log(`error: ${err.message}`);
        // 'close' will follow; let it drive reconnect/reject.
        if (!settled) fail(err);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error("Client closed"));
    this.ws?.close();
  }

  onStatusChange(cb: StatusHandler): void {
    this.onStatus = cb;
  }

  /* ── Auth ──────────────────────────────────────────────────────────── */

  private authenticate(): void {
    this.sendRaw(createMessage(Msg.Auth, { token: this.cfg.token }));
  }

  /* ── Message handling ──────────────────────────────────────────────── */

  private tryParse(raw: WebSocket.RawData): Message | null {
    try {
      const buf = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(new Uint8Array(raw));

      const frame = unpackFrame(buf, this.encKey);
      if (frame.kind === "error") {
        this.log(`frame error: ${frame.reason}`);
        return null;
      }
      // Ignore plaintext frames once we expect encryption.
      if (this.encKey && frame.kind === "plain") return null;

      return asMessage(JSON.parse(frame.text));
    } catch {
      this.log("message parse error");
      return null;
    }
  }

  private onMessage(msg: Message): void {
    switch (msg.type) {
      case Msg.ShellData: {
        const { sessionId, data } = payload<ShellDataPayload>(msg);
        this.onShellData?.(sessionId, data);
        break;
      }
      case Msg.ShellClosed: {
        const p = payload<ShellClosedPayload>(msg);
        this.onShellClosed?.(p.sessionId, p);
        break;
      }
      case Msg.FileChunk: {
        const p = payload<FileChunkPayload>(msg);
        const handler = this.downloadHandlers.get(p.remotePath);
        if (handler) handler(msg, p);
        else this.tryResolvePending(msg);
        break;
      }
      case Msg.ExecResult:
      case Msg.ShellOpened:
      case Msg.UploadDone:
        this.tryResolvePending(msg);
        break;

      case Msg.Ping:
        this.sendRaw(createMessage(Msg.Pong, {}));
        break;

      case Msg.Error: {
        const { message } = payload<{ message: string }>(msg);
        this.log(`server error: ${message}`);
        // An error that carries replyTo resolves the matching pending req.
        if (msg.replyTo) this.tryResolvePending(msg);
        break;
      }
    }
  }

  private tryResolvePending(msg: Message): void {
    // Prefer explicit replyTo, then requestId inside the payload.
    const requestId = msg.replyTo ?? (msg.payload as { requestId?: string }).requestId ?? msg.id;
    const p = this.pending.get(requestId);
    if (p) {
      clearTimeout(p.timer);
      p.resolve(msg);
      this.pending.delete(requestId);
    }
  }

  /* ── Public API ───────────────────────────────────────────────────── */

  /**
   * Open an interactive shell. Returns session ID.
   */
  openShell(cols = 80, rows = 24): Promise<string> {
    return new Promise((resolve, reject) => {
      const m = createMessage(Msg.ShellOpen, { cols, rows });
      this.registerPending(
        m.id,
        (res) => resolve(payload<{ sessionId: string }>(res).sessionId),
        reject,
        10_000,
      );
      this.sendRaw(m);
    });
  }

  /**
   * Send data to an open shell.
   */
  sendShellData(sessionId: string, data: string): void {
    this.sendRaw(createMessage(Msg.ShellData, { sessionId, data }));
  }

  /**
   * Resize an open shell.
   */
  resizeShell(sessionId: string, cols: number, rows: number): void {
    this.sendRaw(createMessage(Msg.ShellResize, { sessionId, cols, rows }));
  }

  /**
   * Close a shell session.
   */
  closeShell(sessionId: string): void {
    this.sendRaw(createMessage(Msg.ShellClose, { sessionId }));
  }

  /**
   * Execute a command and wait for result.
   */
  exec(command: string, timeout = 30_000): Promise<ExecResultPayload> {
    return new Promise((resolve, reject) => {
      const m = createMessage(Msg.Exec, { command, timeout });
      this.registerPending(
        m.id,
        (res) => resolve(payload<ExecResultPayload>(res)),
        reject,
        timeout + 5_000,
      );
      this.sendRaw(m);
    });
  }

  /**
   * Upload a file to the server.
   */
  uploadFile(localPath: string, remotePath: string, chunkSize = DOWNLOAD_CHUNK): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!existsSync(localPath)) return reject(new Error(`File not found: ${localPath}`));

      const stat = statSync(localPath);
      const total = Math.max(1, Math.ceil(stat.size / chunkSize));
      const stream = createReadStream(localPath, { highWaterMark: chunkSize });
      let idx = 0;
      let errored = false;

      stream.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.sendRaw(
          createMessage(Msg.FileUpload, {
            remotePath,
            data: buf.toString("base64"),
            chunkIndex: idx,
            totalChunks: total,
            done: false,
          }),
        );
        idx++;
      });

      stream.on("end", () => {
        // 'error' may have already rejected the promise; don't settle twice.
        if (errored) return;
        this.sendRaw(
          createMessage(Msg.FileUpload, {
            remotePath,
            chunkIndex: idx,
            totalChunks: idx,
            done: true,
          }),
        );
        resolve();
      });

      stream.on("error", (err) => {
        errored = true;
        reject(err);
      });
    });
  }

  /**
   * Download a file from the server.
   *
   * Chunks are written to disk as soon as they arrive in order; only
   * out-of-order chunks are buffered. This bounds peak memory to the
   * network reorder window instead of the full file size, preventing OOM
   * on large downloads.
   */
  downloadFile(remotePath: string, localPath: string, chunkSize = DOWNLOAD_CHUNK): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = createWriteStream(localPath);
      /** Buffered out-of-order chunks, keyed by index. */
      const pending = new Map<number, string>();
      let nextIndex = 0;
      let totalChunks = 0;
      let receivedDone = false;
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.downloadHandlers.delete(remotePath);
        pending.clear();
        if (err) {
          ws.destroy();
          reject(err);
        } else {
          ws.end(resolve);
        }
      };

      // Flush every in-order chunk we currently can, then check completion.
      const flush = () => {
        while (true) {
          const data = pending.get(nextIndex);
          if (data === undefined) break;
          pending.delete(nextIndex);
          if (data) ws.write(Buffer.from(data, "base64"));
          nextIndex++;
        }
        if (receivedDone && nextIndex >= totalChunks) finish();
      };

      const handler: FileChunkHandler = (_msg, p) => {
        const { data, chunkIndex, totalChunks: tc, done: isDone } = p;
        totalChunks = tc;
        if (isDone) receivedDone = true;
        // done && totalChunks === 0 ⇒ empty file.
        if (isDone && totalChunks === 0) {
          finish();
          return;
        }
        if (!isDone || data) {
          pending.set(chunkIndex, data);
        }
        flush();
      };
      this.downloadHandlers.set(remotePath, handler);

      const m = createMessage(Msg.FileDownload, { remotePath, chunkSize });
      // Give the request a timeout so a missing response rejects cleanly.
      this.registerPending(
        m.id,
        () => {
          /* download data flows via handler; this just clears the timer */
        },
        finish,
        60_000,
      );
      this.sendRaw(m);

      ws.on("error", (err) => finish(err));
    });
  }

  /**
   * Register handlers for incoming shell data/closure.
   */
  onShellOutput(onData: ShellDataHandler, onClosed?: ShellClosedHandler): void {
    this.onShellData = onData;
    this.onShellClosed = onClosed;
  }

  /* ── Pending request tracking ──────────────────────────────────────── */

  private registerPending(
    id: string,
    resolve: (msg: Message) => void,
    reject: (err: Error) => void,
    timeout: number,
  ): void {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error("Request timeout"));
    }, timeout);
    this.pending.set(id, { resolve, reject, timer });
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /* ── Reconnection ──────────────────────────────────────────────────── */

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.onStatus?.("reconnecting");
    this.log(`reconnecting in ${this.currentDelay}ms...`);
    const delay = this.currentDelay;
    this.currentDelay = Math.min(this.currentDelay * 2, this.cfg.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => this.log(`reconnect failed: ${err.message}`));
    }, delay);
  }

  /* ── Heartbeat ─────────────────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.sendRaw(createMessage(Msg.Ping, {}));
    }, this.cfg.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /* ── Send ──────────────────────────────────────────────────────────── */

  private sendRaw(msg: Message): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);

    if (this.encKey) {
      if (this.ws.bufferedAmount > 8 * 1024 * 1024) {
        this.log("backpressure drop");
        return;
      }
      this.ws.send(packEncrypted(json, this.encKey));
    } else {
      this.ws.send(packPlain(json));
    }
  }

  private log(msg: string): void {
    console.log(`[wshell] ${msg}`);
  }
}
