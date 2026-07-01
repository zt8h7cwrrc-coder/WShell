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
 *   - Interactive shell, exec, and file upload
 */

import WebSocket from "ws";
import { ChildProcess, spawn } from "child_process";
import {
  createWriteStream,
  WriteStream,
  existsSync,
  statSync,
  createReadStream,
} from "fs";
import { createMessage, Message } from "../shared/protocol.js";
import {
  initCrypto,
  deriveKey,
  encrypt,
  decrypt,
} from "../crypto/index.js";

/* ─── Types ──────────────────────────────────────────────────────────── */

export interface ClientConfig {
  server: string;
  token: string;
  heartbeatMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

interface PendingRequest {
  resolve: (msg: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/* ─── Defaults ───────────────────────────────────────────────────────── */

const DEFAULTS: ClientConfig = {
  server: "ws://localhost:7700",
  token: "",
  heartbeatMs: 20_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
};

/* ─── Client ─────────────────────────────────────────────────────────── */

export class TunnelClient {
  private ws: WebSocket | null = null;
  private cfg: ClientConfig;
  private encKey: Buffer | null = null;
  private shells = new Map<string, ChildProcess>();
  private pending = new Map<string, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentDelay: number;
  private closed = false;
  private onShellData?: (sessionId: string, data: string) => void;
  private onShellClosed?: (sessionId: string) => void;
  private onFileChunk?: (msg: Message) => void;

  constructor(config: Partial<ClientConfig>) {
    this.cfg = { ...DEFAULTS, ...config };
    this.currentDelay = this.cfg.reconnectBaseMs;
  }

  /* ── Connection ────────────────────────────────────────────────────── */

  async connect(): Promise<void> {
    await initCrypto();

    this.closed = false;
    this.ws = new WebSocket(this.cfg.server);

    return new Promise<void>((resolve, reject) => {
      this.ws!.on("open", () => {
        this.log("connected");
        this.currentDelay = this.cfg.reconnectBaseMs;
        this.authenticate();
        this.startHeartbeat();
      });

      this.ws!.on("message", (raw) => this.onRawMessage(raw));

      this.ws!.on("close", () => {
        this.log("disconnected");
        this.stopHeartbeat();
        this.encKey = null;
        this.scheduleReconnect();
      });

      this.ws!.on("error", (err) => {
        this.log(`error: ${err.message}`);
        reject(err);
      });

      // Resolve when authenticated
      const origHandleAuthResult = this.handleAuthResult.bind(this);
      this.handleAuthResult = (msg: Message) => {
        origHandleAuthResult(msg);
        const { success } = msg.payload as { success: boolean };
        if (success) resolve();
      };
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  /* ── Auth ──────────────────────────────────────────────────────────── */

  private authenticate(): void {
    this.sendRaw(createMessage("auth", { token: this.cfg.token }));
  }

  /* ── Message handling ──────────────────────────────────────────────── */

  private onRawMessage(raw: Buffer | ArrayBuffer | Buffer[]): void {
    try {
      const buf = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(new Uint8Array(raw));
      let msgStr: string;

      if (this.encKey && buf[0] === 0x00) {
        const decrypted = decrypt(
          buf.subarray(1),
          this.encKey,
        );
        if (!decrypted) {
          this.log("decryption failed");
          return;
        }
        msgStr = decrypted;
      } else {
        msgStr = buf.toString("utf-8");
      }

      const msg = JSON.parse(msgStr) as Message;
      this.onMessage(msg);
    } catch {}
  }

  private onMessage(msg: Message): void {
    switch (msg.type) {
      case "auth_result":
        this.handleAuthResult(msg);
        break;

      case "shell_opened":
      case "shell_data":
      case "shell_closed":
      case "exec_result":
      case "file_chunk":
      case "upload_done":
        // Forward to registered handler or resolve pending
        if (this.onShellData && msg.type === "shell_data") {
          const { sessionId, data } = msg.payload as { sessionId: string; data: string };
          this.onShellData(sessionId, data);
        } else if (this.onShellClosed && msg.type === "shell_closed") {
          const { sessionId } = msg.payload as { sessionId: string };
          this.onShellClosed(sessionId);
        } else if (this.onFileChunk && msg.type === "file_chunk") {
          this.onFileChunk(msg);
        } else {
          // For exec_result, look for requestId in payload
          const requestId = (msg.payload as any)?.requestId;
          const replyTo = requestId || msg.replyTo || msg.id;
          const p = this.pending.get(replyTo);
          if (p) {
            clearTimeout(p.timer);
            p.resolve(msg);
            this.pending.delete(replyTo);
          }
        }
        break;

      case "ping":
        this.sendRaw(createMessage("pong", {}));
        break;

      case "error":
        this.log(`server error: ${(msg.payload as any).message}`);
        break;
    }
  }

  private handleAuthResult(msg: Message): void {
    const { success, error } = msg.payload as { success: boolean; error?: string };
    if (success) {
      this.encKey = deriveKey(this.cfg.token);
      this.log("authenticated (encrypted)");
    } else {
      this.log(`auth failed: ${error}`);
      this.ws?.close();
    }
  }

  /* ── Public API ────────────────────────────────────────────────────── */

  /**
   * Open an interactive shell. Returns session ID.
   */
  openShell(cols = 80, rows = 24): Promise<string> {
    return new Promise((resolve, reject) => {
      const m = createMessage("shell_open", { cols, rows });
      this.registerPending(m.id, resolve as any, reject, 10_000);
      this.sendRaw(m);
    });
  }

  /**
   * Send data to an open shell.
   */
  sendShellData(sessionId: string, data: string): void {
    this.sendRaw(createMessage("shell_data", { sessionId, data }));
  }

  /**
   * Close a shell session.
   */
  closeShell(sessionId: string): void {
    this.sendRaw(createMessage("shell_close", { sessionId }));
    const proc = this.shells.get(sessionId);
    if (proc) { try { proc.kill(); } catch {} this.shells.delete(sessionId); }
  }

  /**
   * Execute a command and wait for result.
   */
  exec(command: string, timeout = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const m = createMessage("exec", { command, timeout });
      this.registerPending(m.id, (msg) => {
        const p = msg.payload as any;
        resolve({ stdout: p.stdout, stderr: p.stderr, exitCode: p.exitCode });
      }, reject, timeout + 5_000);
      this.sendRaw(m);
    });
  }

  /**
   * Upload a file to the server.
   */
  uploadFile(localPath: string, remotePath: string, chunkSize = 65_536): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!existsSync(localPath)) return reject(new Error(`File not found: ${localPath}`));

      const stat = statSync(localPath);
      const total = Math.ceil(stat.size / chunkSize);
      const stream = createReadStream(localPath, { highWaterMark: chunkSize });
      let idx = 0;

      stream.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.sendRaw(createMessage("file_upload", {
          remotePath, data: buf.toString("base64"), chunkIndex: idx, totalChunks: total, done: false,
        }));
        idx++;
      });

      stream.on("end", () => {
        this.sendRaw(createMessage("file_upload", {
          remotePath, chunkIndex: idx, totalChunks: idx, done: true,
        }));
        resolve();
      });

      stream.on("error", reject);
    });
  }

  /**
   * Download a file from the server.
   */
  downloadFile(remotePath: string, localPath: string, chunkSize = 65_536): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = createWriteStream(localPath);
      const chunks = new Map<number, string>();
      let totalChunks = 0;
      let receivedAll = false;

      const checkDone = () => {
        if (receivedAll && chunks.size === totalChunks) {
          // Write all chunks in order
          for (let i = 0; i < totalChunks; i++) {
            const data = chunks.get(i);
            if (data) ws.write(Buffer.from(data, "base64"));
          }
          ws.end();
          this.onFileChunk = undefined;
          resolve();
        }
      };

      this.onFileChunk = (msg: Message) => {
        const { remotePath: rp, data, chunkIndex, totalChunks: tc, done } = msg.payload as any;
        if (rp !== remotePath) return;
        chunks.set(chunkIndex, data);
        totalChunks = tc;
        if (done) {
          receivedAll = true;
          checkDone();
        }
      };

      this.sendRaw(createMessage("file_download", { remotePath, chunkSize }));

      ws.on("error", reject);
    });
  }

  /**
   * Register handlers for incoming shell data/closure.
   */
  onShellOutput(
    onData: (sessionId: string, data: string) => void,
    onClosed?: (sessionId: string) => void,
  ): void {
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

  /* ── Reconnection ──────────────────────────────────────────────────── */

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.log(`reconnecting in ${this.currentDelay}ms...`);
    setTimeout(() => this.connect(), this.currentDelay);
    this.currentDelay = Math.min(this.currentDelay * 2, this.cfg.reconnectMaxMs);
  }

  /* ── Heartbeat ─────────────────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      this.sendRaw(createMessage("ping", {}));
    }, this.cfg.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /* ── Send ──────────────────────────────────────────────────────────── */

  private sendRaw(msg: Message): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(msg);

    if (this.encKey) {
      const packed = encrypt(json, this.encKey);
      const wire = Buffer.alloc(1 + packed.length);
      wire[0] = 0x00;
      packed.copy(wire, 1);
      this.ws.send(wire);
    } else {
      this.ws.send(json);
    }
  }

  private log(msg: string): void {
    console.log(`[wshell] ${msg}`);
  }
}
