# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-04

### Added

- **Batch file transfer** — Upload or download many small files in a single handshake instead of one round-trip per file. A manifest (path + size + SHA-256) is sent once; chunks for all files stream back-to-back with no per-file ack; the receiver verifies each file's SHA-256 and reports per-file results in one final message. Dramatically faster for many small files where per-file handshakes previously dominated latency.
  - New protocol messages: `batch_upload`, `batch_download`, `batch_data`, `batch_result`.
  - Client: `uploadFiles(files[])` / `downloadFiles(files[])`.
  - CLI: `wshell host put a b c /dir/` and `wshell host get /r/a /r/b ./dir/` (multiple sources = batch into a directory, single source = exact path).
  - Integrity guaranteed by SHA-256 verification even without per-file acks.

### Changed

- **CLI is now SSH-style** — `wshell user@host` drops straight into the remote terminal (auto `openShell` + raw passthrough), instead of showing a `wshell>` prompt that required typing `/shell` first. Removes the learning cost of the old in-session REPL. `vim`/`top`/`sudo`/`Ctrl-C`/`Ctrl-D` now behave exactly like `ssh`.
- **Removed slash commands** — `/shell`, `/exec`, `/put`, `/get`, `/quit` are gone. Their replacements: bare `wshell host` (was `/shell`), `wshell host exec "cmd"` (was `/exec`), `wshell host put`/`get` (was `/put`/`/get`), and remote `exit`/closing the terminal (was `/quit`).
- **Upload message merging** — The last chunk of a file now carries the `done` flag, so a single-chunk file uploads in one message instead of two (data + empty done). Larger files save one message each.

### Fixed

- **Character duplication in interactive shell** — Typing `sudo` appeared as `ssuuddoo`; Chinese IME composition appeared as `sudosudo`. Root cause: `readline.createInterface` (terminal mode) was left open while piping raw bytes to the remote PTY, so both readline and the remote shell echoed each keystroke. Fixed by closing readline before entering raw passthrough (and the SSH-style rewrite removes readline from the shell path entirely).
- **`[wshell] server error: Unknown: ping`** — The client's heartbeat sent `ping` to the server, but the protocol is server-initiated (`ping`) → client (`pong`); the server had no `ping` handler and reported it as unknown. Fixed by replacing the client's outbound ping with an idle-timeout watchdog (closes the link if no frame arrives within 3 heartbeat windows), and adding a tolerant `case Msg.Ping` on the server.

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

[1.1.0]: https://github.com/zt8h7cwrrc-coder/WShell/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/zt8h7cwrrc-coder/WShell/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/zt8h7cwrrc-coder/WShell/releases/tag/v0.1.0
