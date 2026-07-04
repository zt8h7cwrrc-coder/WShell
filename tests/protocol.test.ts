// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMessage, asMessage, payload, Msg, type Message } from "../src/shared/protocol.js";

describe("Msg constants", () => {
  it("are lowercase snake_case strings", () => {
    assert.equal(Msg.Auth, "auth");
    assert.equal(Msg.AuthResult, "auth_result");
    assert.equal(Msg.ShellOpen, "shell_open");
    assert.equal(Msg.ShellData, "shell_data");
    assert.equal(Msg.Exec, "exec");
    assert.equal(Msg.Ping, "ping");
    assert.equal(Msg.Error, "error");
    assert.equal(Msg.BatchUpload, "batch_upload");
    assert.equal(Msg.BatchDownload, "batch_download");
    assert.equal(Msg.BatchData, "batch_data");
    assert.equal(Msg.BatchResult, "batch_result");
  });
});

describe("createMessage", () => {
  it("sets type, id, ts, payload", () => {
    const msg = createMessage(Msg.Ping, {});
    assert.equal(msg.type, "ping");
    assert.ok(typeof msg.id === "string" && msg.id.length > 0);
    assert.ok(typeof msg.ts === "number");
    assert.deepEqual(msg.payload, {});
  });

  it("creates a batch_upload message with file specs", () => {
    const msg = createMessage(Msg.BatchUpload, {
      batchId: "b1",
      files: [{ index: 0, remotePath: "/tmp/a", sha256: "abc" }],
    });
    assert.equal(msg.type, "batch_upload");
    const p = payload<{ batchId: string; files: { index: number; remotePath: string; sha256: string }[] }>(msg);
    assert.equal(p.batchId, "b1");
    assert.equal(p.files.length, 1);
    assert.equal(p.files[0].remotePath, "/tmp/a");
  });

  it("creates a batch_data message", () => {
    const msg = createMessage(Msg.BatchData, {
      batchId: "b1",
      fileIndex: 2,
      data: "aGVsbG8=",
      chunkIndex: 0,
      isLastOfFile: false,
    });
    const p = payload<{ batchId: string; fileIndex: number; isLastOfFile: boolean }>(msg);
    assert.equal(p.fileIndex, 2);
    assert.equal(p.isLastOfFile, false);
  });

  it("sets replyTo when provided", () => {
    const msg = createMessage(Msg.Pong, {}, "parent-id");
    assert.equal(msg.replyTo, "parent-id");
  });

  it("generates unique ids", () => {
    const a = createMessage(Msg.Ping, {});
    const b = createMessage(Msg.Ping, {});
    assert.notEqual(a.id, b.id);
  });

  it("preserves payload data", () => {
    const msg = createMessage(Msg.ShellData, { sessionId: "s1", data: "ls -la" });
    assert.equal(msg.payload.sessionId, "s1");
    assert.equal(msg.payload.data, "ls -la");
  });
});

describe("asMessage", () => {
  it("accepts a well-formed message", () => {
    const raw = {
      type: "auth",
      id: "abc-123",
      ts: Date.now(),
      payload: { token: "secret" },
    };
    const msg = asMessage(raw);
    assert.notEqual(msg, null);
    assert.equal(msg!.type, "auth");
  });

  it("rejects null", () => {
    assert.equal(asMessage(null), null);
  });

  it("rejects non-object", () => {
    assert.equal(asMessage("hello"), null);
    assert.equal(asMessage(42), null);
  });

  it("rejects missing type", () => {
    assert.equal(asMessage({ id: "x", ts: 1, payload: {} }), null);
  });

  it("rejects non-string type", () => {
    assert.equal(asMessage({ type: 42, id: "x", ts: 1, payload: {} }), null);
  });

  it("rejects missing id", () => {
    assert.equal(asMessage({ type: "ping", ts: 1, payload: {} }), null);
  });

  it("rejects non-number ts", () => {
    assert.equal(asMessage({ type: "ping", id: "x", ts: "bad", payload: {} }), null);
  });

  it("rejects missing payload", () => {
    assert.equal(asMessage({ type: "ping", id: "x", ts: 1 }), null);
  });
});

describe("payload helper", () => {
  it("reads typed payload after narrowing", () => {
    const msg = createMessage(Msg.ExecResult, {
      requestId: "r1",
      stdout: "out",
      stderr: "",
      exitCode: 0,
    });
    const p = payload<{ requestId: string; stdout: string }>(msg);
    assert.equal(p.requestId, "r1");
    assert.equal(p.stdout, "out");
  });
});
