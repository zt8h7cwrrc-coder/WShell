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
 *     │──── ping ──────────────────►│
 *     │◄─── pong ───────────────────│
 */

import { randomUUID } from "crypto";

export interface Message {
  type: string;
  id: string;
  payload: Record<string, unknown>;
  ts: number;
  replyTo?: string;
}

/**
 * Create a protocol message.
 * @param type    Message type (e.g. "auth", "shell_data")
 * @param payload Message payload
 * @param replyTo Optional ID this message is replying to
 */
export function createMessage(
  type: string,
  payload: Record<string, unknown>,
  replyTo?: string,
): Message {
  return {
    type,
    id: randomUUID(),
    payload,
    ts: Date.now(),
    replyTo,
  };
}
