// SPDX-License-Identifier: MIT
// Copyright (c) 2026 wshell contributors
/**
 * Tunnel Protocol
 *
 * All communication uses JSON messages over WebSocket.
 * After authentication, messages are encrypted with libsodium secretbox.
 *
 * Message flow:
 *   Client                         Server
 *     │                              │
 *     │──── auth { token } ────────►│
 *     │◄─── auth_result { ok } ─────│
 *     │                              │
 *     │──── shell_open { cols,rows }►│
 *     │◄─── shell_opened { id } ────│
 *     │                              │
 *     │──── shell_data { id, data }─►│
 *     │◄─── shell_data { id, data }─│
 *     │         ...                  │
 *     │──── shell_close { id } ────►│
 *     │                              │
 *     │──── exec { command } ──────►│
 *     │◄─── exec_result { ... } ────│
 *     │                              │
 *     │◄─── ping ───────────────────│ (server-initiated heartbeat)
 *     │──── pong ──────────────────►│
 */

import { randomUUID } from "crypto";

/* ─── Message type strings ────────────────────────────────────────────── */

export const Msg = {
  Auth: "auth",
  AuthResult: "auth_result",
  ShellOpen: "shell_open",
  ShellOpened: "shell_opened",
  ShellData: "shell_data",
  ShellResize: "shell_resize",
  ShellClosed: "shell_closed",
  ShellClose: "shell_close",
  Exec: "exec",
  ExecResult: "exec_result",
  FileUpload: "file_upload",
  FileDownload: "file_download",
  FileChunk: "file_chunk",
  UploadDone: "upload_done",
  Ping: "ping",
  Pong: "pong",
  Error: "error",
  // Batch transfer: one handshake for many small files, with SHA-256
  // verification so correctness doesn't depend on per-file acks.
  BatchUpload: "batch_upload",
  BatchDownload: "batch_download",
  BatchData: "batch_data",
  BatchResult: "batch_result",
} as const;

export type MsgType = (typeof Msg)[keyof typeof Msg];

/* ─── Base message shape ──────────────────────────────────────────────── */

export interface BaseMessage {
  type: MsgType;
  id: string;
  ts: number;
  replyTo?: string;
}

/* ─── Typed payloads ──────────────────────────────────────────────────── */

export interface AuthPayload {
  token: string;
}
export interface AuthResultPayload {
  success: boolean;
  error?: string;
}
export interface ShellOpenPayload {
  cols?: number;
  rows?: number;
}
export interface ShellOpenedPayload {
  sessionId: string;
}
export interface ShellDataPayload {
  sessionId: string;
  data: string;
}
export interface ShellResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}
export interface ShellClosedPayload {
  sessionId: string;
  exitCode: number | null;
  signal?: string | null;
}
export interface ShellClosePayload {
  sessionId: string;
}
export interface ExecPayload {
  command: string;
  timeout?: number;
}
export interface ExecResultPayload {
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string | null;
}
export interface FileUploadPayload {
  remotePath: string;
  data?: string; // base64
  chunkIndex: number;
  totalChunks?: number;
  done: boolean;
}
export interface FileDownloadPayload {
  remotePath: string;
  chunkSize?: number;
}
export interface FileChunkPayload {
  remotePath: string;
  data: string; // base64
  chunkIndex: number;
  totalChunks: number;
  done: boolean;
}
export interface UploadDonePayload {
  remotePath: string;
  success: boolean;
  error?: string;
}

/* ─── Batch transfer payloads ─────────────────────────────────────────── */
//
// One handshake (the Start message) carries the manifest for every file in
// the batch; chunks for all files then stream back-to-back in BatchData
// messages without any per-file round-trip. SHA-256 hashes declared up
// front let the receiver verify integrity once at the end, so dropping the
// per-file ack does not sacrifice correctness.

export interface BatchFileSpec {
  /** Index within the batch; matches `fileIndex` on BatchData chunks. */
  index: number;
  /** Server-side path for upload, remote path for download. */
  remotePath: string;
  /** Expected byte length (informational; used for early rejection). */
  size?: number;
  /** Expected SHA-256 hex of the file content. Required for verification. */
  sha256: string;
}

export interface BatchUploadPayload {
  batchId: string;
  files: BatchFileSpec[];
}
export interface BatchDownloadPayload {
  batchId: string;
  files: string[]; // remote paths
  chunkSize?: number;
}
export interface BatchDataPayload {
  batchId: string;
  fileIndex: number;
  data: string; // base64
  chunkIndex: number;
  isLastOfFile: boolean;
  /** Present on the last chunk so the receiver can verify without a map. */
  sha256?: string;
}
export interface BatchFileResult {
  fileIndex: number;
  remotePath: string;
  success: boolean;
  error?: string;
  /** True when the declared hash matched the received bytes. */
  sha256Ok?: boolean;
}
export interface BatchResultPayload {
  batchId: string;
  results: BatchFileResult[];
}

export interface EmptyPayload {}
export interface ErrorPayload {
  message: string;
}

/* ─── Discriminated message unions ────────────────────────────────────── */

export type MessageMap = {
  [Msg.Auth]: AuthPayload;
  [Msg.AuthResult]: AuthResultPayload;
  [Msg.ShellOpen]: ShellOpenPayload;
  [Msg.ShellOpened]: ShellOpenedPayload;
  [Msg.ShellData]: ShellDataPayload;
  [Msg.ShellResize]: ShellResizePayload;
  [Msg.ShellClosed]: ShellClosedPayload;
  [Msg.ShellClose]: ShellClosePayload;
  [Msg.Exec]: ExecPayload;
  [Msg.ExecResult]: ExecResultPayload;
  [Msg.FileUpload]: FileUploadPayload;
  [Msg.FileDownload]: FileDownloadPayload;
  [Msg.FileChunk]: FileChunkPayload;
  [Msg.UploadDone]: UploadDonePayload;
  [Msg.BatchUpload]: BatchUploadPayload;
  [Msg.BatchDownload]: BatchDownloadPayload;
  [Msg.BatchData]: BatchDataPayload;
  [Msg.BatchResult]: BatchResultPayload;
  [Msg.Ping]: EmptyPayload;
  [Msg.Pong]: EmptyPayload;
  [Msg.Error]: ErrorPayload;
};

/** A fully-typed message with a payload matching its `type`. */
export type TypedMessage<T extends MsgType = MsgType> = BaseMessage & {
  type: T;
  payload: MessageMap[T];
};

/**
 * Strict union of every possible typed message. Use this for *outgoing*
 * messages (results of {@link createMessage}) — each member is a
 * discriminated union arm keyed by `type`.
 */
export type AnyMessage = {
  [T in MsgType]: BaseMessage & { type: T; payload: MessageMap[T] };
}[MsgType];

/**
 * Loose message shape used where the type isn't statically known, e.g. when
 * parsing incoming wire bytes. This is the same discriminated union as
 * {@link AnyMessage}: outgoing messages assign cleanly, and incoming
 * messages can be narrowed on `type`. Use {@link payload} to read the
 * payload as a concrete type.
 */
export type Message = AnyMessage;

/** Read a message's payload as a concrete type (unsafe; caller must narrow on `type`). */
export function payload<T>(msg: Message): T {
  return msg.payload as unknown as T;
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Create a protocol message.
 * @param type    Message type (e.g. Msg.Auth, Msg.ShellData)
 * @param payload Message payload
 * @param replyTo Optional ID this message is replying to
 */
export function createMessage<T extends MsgType>(
  type: T,
  payload: MessageMap[T],
  replyTo?: string,
): AnyMessage {
  return {
    type,
    id: randomUUID(),
    payload,
    ts: Date.now(),
    replyTo,
  } as AnyMessage;
}

/**
 * Narrow an unknown wire object to a Message, validating only the shape
 * required for routing. Returns null on malformed input.
 */
export function asMessage(raw: unknown): Message | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Message).type !== "string" ||
    typeof (raw as Message).id !== "string" ||
    typeof (raw as Message).ts !== "number" ||
    typeof (raw as Message).payload !== "object"
  ) {
    return null;
  }
  return raw as Message;
}
