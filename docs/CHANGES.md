# WShell — Optimization Changelog

> Complete record of the optimization work across three review passes. All
> changes are on-disk, `tsc --noEmit` clean, `npm test` 52/52 passing,
> `npm run build` succeeding, and `node-pty` verified to load from `dist/`.

A 30-point code audit identified issues in four severity tiers: security /
correctness (P0–P1), robustness (P0–P2), code quality (P2), and engineering
(P2–P3). The work below was carried out over three passes.

---

## Round 1 — Core rewrite (security, robustness, PTY, protocol)

### Security / correctness

**Unified wire frame format** (`src/crypto/index.ts`)
- **Before:** two conflicting schemes coexisted — `encrypt()` packed
  `[4-byte nonce length][nonce][ciphertext]`, but the server/client
  detected encryption by testing `buf[0] === 0x00`. That magic byte only
  worked by accident (nonce length 24 has a zero high byte); a different
  nonce length would silently misclassify frames.
- **After:** one explicit format — `[1-byte type][24-byte nonce][ciphertext + MAC]`,
  `type = 0x01` encrypted, `0x00` plaintext. New shared helpers
  `packEncrypted()` / `packPlain()` / `unpackFrame()` replace the duplicate
  frame-packing logic that was copy-pasted in server and client.

**Full 256-bit token fingerprints** (`src/shared/auth.ts`)
- Token fingerprints were truncated to 16 hex chars (64-bit), dropping
  preimage resistance to 64-bit. Now stores the full SHA-256 digest
  (64 hex = 256 bit) and compares with `timingSafeEqual` (constant-time).

**Auth failure now closes + rate-limits** (`src/server/index.ts`)
- Previously a failed auth only sent `{success:false}` and left the
  connection open for the 10 s timeout — unlimited brute-force attempts.
- Now: failed auth closes the socket immediately, and a per-connection
  counter allows at most 5 attempts per 60 s window.

**Path traversal sandbox** (`src/server/index.ts`)
- `handleFileUpload` / `handleFileDownload` accepted any client-supplied
  path (`../../../../etc/cron.d/x`). Added `resolveSafePath()` that
  resolves against an optional `--root` sandbox, rejects traversal escapes,
  and caps uploads at 256 MB per file.

**WebSocket backpressure** (server `send()`, client `sendRaw()`)
- `ws.send()` was called without checking `bufferedAmount`; large outputs
  could grow memory unbounded. Now drops frames when the WS buffer
  exceeds 8 MB instead of queuing forever.

**Honest exec exit codes** (`src/server/index.ts`)
- `error?.code ?? 0` returned `0` when a process was killed by signal
  (code is `null`). Now distinguishes signal vs. exit code and reports
  `-1` for signal-killed processes.

**No internal-error leakage** (`src/server/index.ts`)
- `JSON.parse` failures used to echo `e.message` to the client (potential
  path/info leak). Replaced with a generic `sendError()`.

### Robustness

**PTY support** (`src/server/pty.ts` — new file)
- The server used `child_process.spawn`, which is not a PTY — so
  `vim`/`top`/`less`/`sudo` (password prompts) were broken, `COLUMNS`/
  `LINES` were ignored, and `handleShellResize` was a no-op TODO.
- Added a `PtyHandle` abstraction with two implementations:
  `PtyRealHandle` (wraps `node-pty` — real PTY, resize + signal-correct
  exit codes) and `PtySpawnHandle` (spawn fallback when `node-pty` can't
  load). `spawnPty()` picks automatically; `ptyAvailable()` queries it.

**`connect()` no longer monkey-patches** (`src/client/index.ts`)
- Each `connect()` re-wrapped `this.handleAuthResult`, so N reconnects
  stacked N layers and captured stale `resolve` closures. Replaced with a
  one-shot listener on the first `auth_result` message with a 10 s timeout.

**Removed all CLI sleep-waits** (`src/cli/client.ts`)
- `await new Promise(r => setTimeout(r, 1000/1500))` was used to "wait for
  connection" — a symptom of the unreliable `connect()` resolve timing.
  With #connect fixed, all sleeps were deleted; `connect()` now resolves
  the moment auth succeeds.

**`/get` wired up** (`src/cli/client.ts`)
- The `/get` command was a placeholder printing
  "download not yet implemented in this demo". Now calls
  `client.downloadFile`.

**Safe raw-mode handling** (`src/cli/client.ts`)
- `setRawMode(true)` was never restored on failure/exit, leaving the
  terminal in raw mode with scrambled input. Added `enterRawMode()` /
  `leaveRawMode()` with `SIGINT`/`SIGTERM` cleanup hooks.

**Terminal resize forwarding** (`src/cli/client.ts`)
- `process.stdout.on("resize")` now auto-forwards new cols/rows to the
  remote shell via `client.resizeShell()`.

### Protocol & types

**Typed message protocol** (`src/shared/protocol.ts`)
- Every message shared `type: string` + `payload: Record<string,unknown>`,
  read via `as any` casts. Replaced with: a `Msg` constants object, 20+
  per-message payload interfaces, a `MessageMap` discriminated union,
  type-safe `createMessage<T>()`, an `asMessage()` validator (replaces
  bare `JSON.parse`), and a `payload<T>()` reader (replaces `as any`).

**sodium-native types** (`src/crypto/sodium-native.d.ts`)
- Hand-written declaration was incomplete and had a broken default export
  (made every `sodium.xxx` usage `unknown`). Filled in
  `crypto_generichash_BYTES_MIN/MAX`, `randombytes_buf` overloads, and a
  correct default-export mirror.

### Config & auth hardening

**Config resilience** (`src/shared/config.ts`)
- `JSON.parse` failures crashed the CLI outright. Added `try/catch` with a
  friendly message, defensive per-field coercion for partial configs, and
  `0600` permissions on `save()`. Exported `CONFIG_DIR` / `CONFIG_FILE`.

**Auth file location** (`src/shared/auth.ts`)
- Default auth file was the cwd-relative `./wshell-auth.json`. Moved to
  `~/.wshell/auth.json` (exported as `DEFAULT_AUTH_FILE`), consistent with
  the client config location. `load()` got `try/catch`, `save()` got
  `0600`.

### CLI

- `src/cli/server.ts`: `wshelld start` subcommand (previously "Unknown
  command"), `-r/--root` sandbox option, `DEFAULT_AUTH_FILE` default.
- `src/cli/start.ts`: same `--root` / `DEFAULT_AUTH_FILE` support.
- `src/cli/util.ts` (new): shared `fatal()` helper.

### Dependencies

- Removed unused `yargs` + `@types/yargs` (declared but never imported).
- Added `node-pty@^1.1.0` (runtime, for PTY support).

---

## Round 2 — Tests, build, licenses

**Unit test suite** (4 files, 52 tests, all passing via `node:test` — zero
extra dependencies):

| File | Tests | Coverage |
|------|-------|----------|
| `tests/crypto.test.ts` | 15 | `deriveKey` determinism/length, `encrypt`/`decrypt` round-trip + tamper + wrong-key + truncation, `packEncrypted`/`unpackFrame` round-trip + plaintext + keyless + empty + unknown-type + MAC-tamper |
| `tests/protocol.test.ts` | 14 | `Msg` constants, `createMessage` fields/replyTo/unique-id/payload-preserve, `asMessage` accepts valid + rejects 8 invalid inputs, `payload<T>()` reader |
| `tests/config.test.ts` | 10 | `parseTarget` five input formats, config read/write round-trip, missing file returns empty, malformed JSON throws, partial-field defensive coerce |
| `tests/auth.test.ts` | 13 | `fingerprint` 64-char hex + determinism, `addUser`+`verifyToken` correct/wrong/empty/persist-reload, `verifyCredentials`, `listUsers`/`deleteUser` |

- `package.json`: added `"test": "tsx --test tests/*.test.ts"`.
- Fixed a `tsc` error in `client/index.ts` (the `FileChunkHandler` callback
  destructured `msg.payload` directly from a union type TS couldn't narrow;
  switched to the already-typed second argument).
- `.gitignore`: added `*.tsbuildinfo`, `coverage/`, `.env`.
- Regenerated `THIRD_PARTY_LICENSES.md` (22 packages; `yargs` removed,
  `node-pty` added).

---

## Round 3 — Leftover fixes, critical ESM bug, OOM protection, CI, docs

### Leftover bug fixes

- **`DEFAULTS.authFile`** — still pointed at the legacy `"wshell-auth.json"`
  string. A direct `new TunnelServer({})` (no CLI) resolved auth against
  the wrong path. Now uses `DEFAULT_AUTH_FILE`.
- **`client.uploadFile` double-settle guard** — the stream `"end"` handler
  could fire after `"error"` had already rejected the promise. The `end`
  handler now checks the `errored` flag.
- **`handleExec` documentation** — added a JSDoc block stating plainly that
  `child_process.exec(command)` with a client-supplied string is *by design*
  (this is a remote shell), and that `cwd` is confined to `rootDir`.

### Critical production-only ESM bug (newly discovered)

`src/server/pty.ts` loaded `node-pty` with:

```ts
const { createRequire } = require("module") as typeof import("module");
```

The project is `"type": "module"`, so bare `require` is **undefined** at
runtime. The `try/catch` swallowed the `ReferenceError` silently, so
`loadPty()` always returned `null` and the server **always fell back to
`spawn`** — meaning every PTY feature Round 1 added (real resize,
`vim`/`top`/`sudo`, signal-correct exit codes) was dead code in production
(`node dist/`), while appearing to "work" only under `tsx` dev mode.

**Fix:** `import { createRequire } from "module"` at the top of the file.
Verified `ptyAvailable()` now returns `true` from the compiled `dist/` output.

### OOM protection (new)

The prior review flagged backpressure but the OOM surface was broader:

| Risk | Before | After |
|------|--------|-------|
| Large file **download** (client) | Buffered *all* base64 chunks in a `Map`, wrote once at the end → file-size memory | Streaming sequential write; only out-of-order chunks buffered → bounded by reorder window |
| Unbounded concurrent connections | No cap — a connection flood grows RSS until OOM-kill | `maxConnections` (default 64, `-m/--max-conn`), enforced at `onConnect` |
| Process-wide memory | No monitoring | RSS watchdog every 30 s; new connections refused at 80 % of the 512 MB guard |
| Download **server** stream | `'data'` fired regardless of WS buffer state → whole file into RAM on a slow client | `pause()` at 4 MB buffered, `resume()` on `'drain'` |

The WS server also gets a `maxPayload` so a single oversized frame can't
allocate unbounded memory.

### CI

`.github/workflows/ci.yml` — `build` (tsc + compile) and `test` (node:test)
jobs on an `ubuntu-latest` + `macos-latest` matrix. Native modules
(`sodium-native`, `node-pty`) compile in the runner's toolchain.

### README alignment

- **Threat model** section: pre-shared key model, no PFS, `ws://` default
  with app-layer encryption, `--root` sandbox, X25519 as future work.
- **Security table** updated: full 256-bit fingerprints, constant-time
  compare, new frame format, rate-limited auth, path sandbox, backpressure,
  OOM protection, `0600` file perms.
- **Frame format** corrected to `[1-byte type][24-byte nonce][ciphertext+MAC]`.
- **Auth file default** → `~/.wshell/auth.json` everywhere.
- **`node-pty`** install note + fallback behaviour documented.
- **`-r/--root`** and **`-m/--max-conn`** options documented.

### ESLint / Prettier (added then removed)

Added in Round 3 as one-shot checks, then removed per maintainer preference
(these are throwaway checks, not runtime dependencies): deleted
`eslint`/`@typescript-eslint/*`/`prettier`/`eslint-config-prettier` from
`devDependencies` (−120 packages), removed `.eslintrc.cjs` /
`.eslintignore` / `.prettierrc.json` / `.prettierignore`, dropped
`lint`/`format` scripts and the CI `lint` job. Code formatting was unified
with Prettier before removal and is preserved as-is.

---

## Verification (final state)

| Check | Result |
|-------|--------|
| `tsc --noEmit` | 0 errors |
| `npm test` | 52 tests, 0 fail |
| `npm run build` | success, `dist/` complete |
| `node-pty` loads from `dist/` | `ptyAvailable() = true` |
| `THIRD_PARTY_LICENSES.md` | 22 packages, no eslint/prettier, sodium-native + node-pty present |

---

## File summary

**New files:** `src/server/pty.ts`, `src/cli/util.ts`, `tests/crypto.test.ts`,
`tests/protocol.test.ts`, `tests/config.test.ts`, `tests/auth.test.ts`,
`.github/workflows/ci.yml`, `CHANGES.md`

**Modified:** `src/crypto/index.ts`, `src/crypto/sodium-native.d.ts`,
`src/shared/protocol.ts`, `src/shared/config.ts`, `src/shared/auth.ts`,
`src/server/index.ts`, `src/client/index.ts`, `src/cli/client.ts`,
`src/cli/server.ts`, `src/cli/start.ts`, `package.json`,
`package-lock.json`, `.gitignore`, `README.md`, `THIRD_PARTY_LICENSES.md`

---

## Known limitations (documented in README threat model)

- **No forward secrecy (PFS).** Token leak = all recorded history
  decryptable. Future work: X25519 ephemeral key exchange.
- **Default transport is plain `ws://`.** Encryption is at the application
  layer; use `wss://` reverse proxy for defence-in-depth.
- **Authenticated = fully trusted.** A connected client can run arbitrary
  commands — use `--root` to confine file transfers and exec cwd.
