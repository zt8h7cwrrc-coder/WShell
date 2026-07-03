# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-03

### Added

- **PTY support** — Real pseudo-terminal via `node-pty`, with automatic fallback to `child_process.spawn`. Enables `vim`, `top`, `sudo`, and proper signal handling.
- **Typed message protocol** — Discriminated union types, per-message payload interfaces, `asMessage()` validator, and `payload<T>()` reader. Eliminates all `as any` casts.
- **Path traversal sandbox** — `resolveSafePath()` resolves against optional `--root` sandbox, rejects traversal escapes, caps uploads at 256 MB.
- **OOM protection** — `maxConnections` limit (default 64, `-m` flag), RSS watchdog at 80% of 512 MB guard, streaming download (no full-file buffering), server-side backpressure with `pause()`/`resume()`.
- **Rate limiting** — Failed auth closes socket immediately; per-connection counter allows max 5 attempts per 60s window.
- **Terminal resize forwarding** — `process.stdout.on("resize")` auto-forwards cols/rows to remote shell.
- **Safe raw-mode handling** — `enterRawMode()`/`leaveRawMode()` with `SIGINT`/`SIGTERM` cleanup hooks.
- **Unit test suite** — 52 tests across 4 files (`crypto`, `protocol`, `config`, `auth`), zero extra dependencies.
- **CI pipeline** — GitHub Actions with `build` and `test` jobs on `ubuntu-latest` + `macos-latest` matrix.
- **`wshelld start`** subcommand for daemon mode.
- **`-r/--root`** sandbox option for file transfers and exec cwd.
- **`-m/--max-conn`** option to limit concurrent connections.

### Changed

- **Wire format** — Unified to `[1-byte type][24-byte nonce][ciphertext+MAC]`. `type = 0x01` encrypted, `0x00` plaintext. Shared `packEncrypted()`/`packPlain()`/`unpackFrame()` replace duplicate logic.
- **Token fingerprints** — Full SHA-256 digest (64 hex chars) with constant-time comparison via `timingSafeEqual`.
- **Auth file location** — Moved from cwd-relative `./wshell-auth.json` to `~/.wshell/auth.json`.
- **Config resilience** — `try/catch` on parse, defensive per-field coercion, `0600` file permissions.
- **Exec exit codes** — Distinguishes signal vs. exit code; reports `-1` for signal-killed processes.
- **WebSocket backpressure** — Drops frames when buffer exceeds 8 MB instead of unbounded queuing.
- **Server download stream** — `pause()` at 4 MB buffered, `resume()` on `drain`.

### Fixed

- **ESM production bug** — `node-pty` loading failed silently in compiled output due to missing `createRequire` import. Fixed with `import { createRequire } from "module"`.
- **`connect()` monkey-patching** — Each reconnect stacked N layers of `handleAuthResult` wrappers. Replaced with one-shot listener.
- **CLI sleep-waits** — Removed `await new Promise(r => setTimeout(r, ...))` hacks; `connect()` now resolves when auth succeeds.
- **`/get` command** — Was a placeholder; now calls `client.downloadFile`.
- **Internal error leakage** — `JSON.parse` failures no longer echo `e.message` to client.
- **`DEFAULTS.authFile`** — Still pointed at legacy path when using `TunnelServer` directly.
- **`client.uploadFile` double-settle** — Stream `end` handler could fire after `error` already rejected.

### Removed

- `yargs` and `@types/yargs` (declared but never imported).
- ESLint/Prettier (one-shot checks, not runtime dependencies).

## [0.1.0] - 2026-07-01

### Added

- Initial release with WebSocket-based encrypted remote shell.
- SSH-like CLI: `wshell user@host`, `exec`, `put`, `get`.
- libsodium encryption (XChaCha20-Poly1305) via `sodium-native`.
- Auto-reconnect with exponential backoff.
- Server with user management (`wshelld user add/list/remove`).
- Config management (`~/.wshell/config.json`).
- Third-party license tracking.

[1.0.0]: https://github.com/zt8h7cwrrc-coder/WShell/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/zt8h7cwrrc-coder/WShell/releases/tag/v0.1.0
