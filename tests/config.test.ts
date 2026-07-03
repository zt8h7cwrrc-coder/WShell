// SPDX-License-Identifier: MIT
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/shared/config.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpDir = join(tmpdir(), "wshell-test-" + process.pid);

describe("Config.parseTarget", () => {
  it("parses user@host", () => {
    const r = Config.parseTarget("admin@1.2.3.4");
    assert.equal(r.user, "admin");
    assert.equal(r.host, "1.2.3.4");
    assert.equal(r.port, undefined);
  });

  it("parses user@host:port", () => {
    const r = Config.parseTarget("admin@1.2.3.4:8080");
    assert.equal(r.user, "admin");
    assert.equal(r.host, "1.2.3.4");
    assert.equal(r.port, 8080);
  });

  it("parses host without user", () => {
    const r = Config.parseTarget("1.2.3.4");
    assert.equal(r.user, undefined);
    assert.equal(r.host, "1.2.3.4");
    assert.equal(r.port, undefined);
  });

  it("parses host:port without user", () => {
    const r = Config.parseTarget("1.2.3.4:9090");
    assert.equal(r.user, undefined);
    assert.equal(r.host, "1.2.3.4");
    assert.equal(r.port, 9090);
  });

  it("parses user@hostname:port with dashes", () => {
    const r = Config.parseTarget("root@my-server.example.com:22");
    assert.equal(r.user, "root");
    assert.equal(r.host, "my-server.example.com");
    assert.equal(r.port, 22);
  });
});

describe("Config load/save round-trip", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty config when file does not exist", () => {
    const cfg = new Config(join(tmpDir, "missing.json"));
    assert.deepEqual(cfg.listHosts(), {});
  });

  it("save → load round-trip preserves host data", () => {
    const path = join(tmpDir, "config.json");
    const cfg = new Config(path);
    cfg.addHost("prod", {
      host: "1.2.3.4",
      port: 7700,
      user: "admin",
      token: "tok-123",
    });

    // Re-read from disk
    const cfg2 = new Config(path);
    const h = cfg2.getHost("prod");
    assert.notEqual(h, undefined);
    assert.equal(h!.host, "1.2.3.4");
    assert.equal(h!.port, 7700);
    assert.equal(h!.user, "admin");
    assert.equal(h!.token, "tok-123");
  });

  it("removeHost returns false for unknown host", () => {
    const cfg = new Config(join(tmpDir, "config.json"));
    assert.equal(cfg.removeHost("nonexistent"), false);
  });

  it("handles malformed JSON gracefully (throws with message)", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not valid json");
    assert.throws(() => new Config(path), /Failed to parse config/);
  });

  it("coerces partial host fields defensively", () => {
    const path = join(tmpDir, "partial.json");
    // Missing fields, wrong types — should coerce
    writeFileSync(
      path,
      JSON.stringify({
        hosts: {
          h1: { host: "1.2.3.4" }, // missing port, user, token
        },
      }),
    );
    const cfg = new Config(path);
    const h = cfg.getHost("h1");
    assert.notEqual(h, undefined);
    assert.equal(h!.host, "1.2.3.4");
    assert.equal(h!.port, 0);
    assert.equal(h!.user, "");
  });
});
