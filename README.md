# WShell

Encrypted direct-connect remote shell — a stable, secure alternative to SSH.

## Why?

SSH drops connections when the network hiccups. WShell doesn't:

| Feature | SSH | WShell |
|---------|-----|--------|
| Protocol | TCP raw | WebSocket |
| Encryption | Built-in | libsodium (XChaCha20-Poly1305) |
| Reconnect | Manual | Auto (exponential backoff) |
| Session persistence | Lost on disconnect | Kept server-side |
| Heartbeat | TCP keepalive (slow) | App-level 15s |
| Message buffering | None | Yes |

## Architecture

```
┌──────────────┐         ┌──────────────┐
│  Client      │◄──TLS──►│  Server      │
│  (your Mac)  │  or     │  (VPS)       │
│              │  plain  │              │
│  - CLI REPL  │  WS     │  - Shell     │
│  - Auto      │         │  - Exec      │
│    reconnect │         │  - Files     │
└──────────────┘         └──────────────┘
```

After authentication, all messages are encrypted at the application layer with
libsodium (the WebSocket transport itself is plain `ws://` by default — use a
`wss://` reverse proxy for TLS, see [Deployment](#deployment)):

- Master key: blake2b hash of the auth token
- Session key: 32-byte subkey derived via `crypto_kdf` (deterministic, both
  peers derive the same key — pre-shared key model, no PFS)
- Each message carries a fresh random 24-byte nonce
- XChaCha20-Poly1305 authenticated encryption (confidentiality + integrity)
- Wire frame: `[1-byte type][24-byte nonce][ciphertext + MAC]`

## Install

Requires Node.js >= 18 and a C++ toolchain (the native modules `sodium-native`
and `node-pty` need compiling — `build-essential` on Debian/Ubuntu, Xcode
Command Line Tools on macOS, `windows-build-tools` on Windows).

```bash
git clone https://github.com/zt8h7cwrrc-coder/WShell.git
cd wshell
npm run build
```

`npm run build` installs dependencies and compiles TypeScript.

> **Interactive programs (vim, top, less, sudo):** these need a real PTY,
> provided by `node-pty`. If the native module fails to load on your
> platform, WShell automatically falls back to `child_process.spawn`, which
> has no PTY — interactive TUI programs won't work in that case, but
> non-interactive shell/exec/file transfer still function.

## Quick Start

### 1. Server (deploy on your VPS)

```bash
# Add a user (save the generated token)
node dist/cli/server.js user add admin -p mypassword

# Start the server
node dist/cli/server.js start
```

Output:
```
  User "admin" created.
  Token: a1b2c3d4e5f6...

  Add this host to your client:
    wshell config add myhost admin@<server-ip>
  Then edit ~/.wshell/config.json to paste the token.
```

**Important: Keep the token safe — you'll need it for client connections.**

### 2. Client (on your local machine)

#### Option A: Connect directly with token

```bash
node dist/cli/client.js --token <token> --server ws://your-vps:7700 admin@your-vps
```

#### Option B: Save config first, then connect

```bash
# Save host config
node dist/cli/client.js config add myhost admin@your-vps

# Edit config file and paste the token
# ~/.wshell/config.json:
# {
#   "hosts": {
#     "myhost": {
#       "user": "admin",
#       "host": "your-vps",
#       "port": 7700,
#       "token": "a1b2c3d4e5f6..."
#     }
#   }
# }

# Connect using saved name
node dist/cli/client.js myhost
```

## Usage

WShell's CLI mirrors `ssh` / `scp`: `wshell <user@host>` drops you straight
into the remote terminal; subcommands handle one-shot operations.

### Client Commands (wshell)

```bash
# Interactive shell — connects, opens a remote PTY, enters raw passthrough.
# You're talking directly to the remote terminal: vim/top/sudo/Ctrl-C/Ctrl-D
# all work just like ssh. Type "exit" on the remote side to leave.
wshell <user@host>
wshell <user@host:port>         # With port
wshell <name>                   # Use saved config

# Run one command, print its output, exit (like `ssh host cmd`)
wshell <user@host> exec "ls -la"
wshell <user@host> exec "df -h"

# Upload a file (like `scp local host:remote`)
wshell <user@host> put ./local.txt /remote/path.txt

# Upload many files in one handshake (batch, with SHA-256 verify)
wshell <user@host> put a.txt b.txt c.txt /remote/dir/

# Download a file (like `scp host:remote local`)
wshell <user@host> get /remote/path.txt ./local.txt

# Download many files in one handshake (batch, with SHA-256 verify)
wshell <user@host> get /remote/a.txt /remote/b.txt ./local-dir/

# Generate new token
wshell keygen

# Show help
wshell help
```

> The old in-session `/shell`, `/exec`, `/put`, `/get`, `/quit` REPL commands
> have been removed. Their replacements are the `exec` / `put` / `get`
> subcommands above (run from a separate terminal, just as you would with
> `scp` alongside `ssh`); `/shell` is now the default behaviour of a bare
> `wshell <host>`, and `/quit` is just `exit` on the remote side or closing
> the terminal.

### Server Commands (wshelld)

```bash
# User management
node dist/cli/server.js user add <name> -p <password>    # Add user
node dist/cli/server.js user list                         # List users
node dist/cli/server.js user remove <name>                # Remove user

# Start daemon
node dist/cli/server.js start

# Options
  -P, --port <port>     Listen port (default: 7700)
  -H, --host <host>     Listen address (default: 0.0.0.0)
  -a, --auth <file>     Auth file path (default: ~/.wshell/auth.json)
  -r, --root <dir>      Sandbox root: confine file transfers & exec cwd to <dir>
  -m, --max-conn <n>    Max concurrent clients (default: 64)

# Show help
node dist/cli/server.js help
```

### Config File

Configuration is stored at `~/.wshell/config.json`:

```json
{
  "hosts": {
    "myhost": {
      "user": "admin",
      "host": "123.45.67.89",
      "port": 7700,
      "token": "your-token"
    },
    "dev": {
      "user": "dev",
      "host": "10.0.0.1",
      "port": 7700,
      "token": "another-token"
    }
  }
}
```

## Security

| Layer | Mechanism |
|-------|-----------|
| Authentication | bcrypt password hashing (10 rounds) |
| Token | Random 32-byte generation, stored as **full** SHA-256 fingerprints (256-bit) |
| Token comparison | Constant-time (`timingSafeEqual`) |
| Encryption | libsodium XChaCha20-Poly1305 (authenticated) |
| Key derivation | `crypto_kdf` — blake2b master key → 32-byte subkey, from auth token |
| Message format | `[1-byte type][24-byte nonce][ciphertext + 16-byte MAC]` — `0x01` encrypted, `0x00` plaintext |
| Before auth | Plaintext JSON (framed with `0x00` type byte) |
| After auth | Fully encrypted (every frame carries a fresh random nonce) |
| Auth failure | Connection closed immediately + per-connection rate limit (5 attempts / 60 s) |
| File transfer | Path sandboxing via `--root`, traversal rejected, 256 MB per-file cap |
| Backpressure | Frames dropped at 8 MB WebSocket buffer saturation; download streams pause/resume on slow clients |
| OOM protection | Concurrent-connection cap, RSS watchdog refuses new clients near the memory ceiling, streaming file writes |
| Secrets at rest | Config & auth files written with `0600` permissions |

### Threat Model

WShell uses a **pre-shared key** model: both peers derive the same symmetric
key from the auth token. Keep the following in mind:

- **No forward secrecy (PFS).** If the token is leaked, all historically
  recorded traffic can be decrypted. Treat the token with the same care as
  an SSH private key.
- **Transport is plain `ws://` by default.** Encryption happens at the
  application layer, so payload bytes are protected in transit, but for
  defence-in-depth use `wss://` (TLS) via a reverse proxy (see below) so
  the handshake and framing metadata are also protected.
- **Authenticated = fully trusted.** Once a client authenticates it can run
  arbitrary commands — that is the point of a remote shell. Use `--root` to
  confine file transfers and exec's working directory.
- Future work: an X25519 ephemeral key exchange would add PFS while keeping
  token-based authentication.

## Project Structure

```
wshell/
├── src/
│   ├── cli/
│   │   ├── client.ts         # Client CLI
│   │   ├── server.ts         # Server CLI
│   │   ├── start.ts          # Server entry point (wshelld-start)
│   │   └── util.ts           # Shared CLI helpers
│   ├── server/
│   │   ├── index.ts          # TunnelServer class
│   │   └── pty.ts            # PTY abstraction (node-pty w/ spawn fallback)
│   ├── client/
│   │   └── index.ts          # TunnelClient class
│   ├── crypto/
│   │   ├── index.ts          # libsodium encryption & frame packing
│   │   └── sodium-native.d.ts  # sodium-native types
│   └── shared/
│       ├── protocol.ts       # Typed message protocol
│       ├── auth.ts           # Authentication
│       └── config.ts         # Config management
├── tests/                    # Unit tests (node:test)
│   ├── crypto.test.ts
│   ├── protocol.test.ts
│   ├── config.test.ts
│   └── auth.test.ts
├── scripts/
│   └── generate-licenses.cjs # License generator
├── THIRD_PARTY_LICENSES.md   # Auto-generated licenses
├── LICENSE                   # MIT License
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
# Dev mode (no compile needed)
npm run dev:server            # Start server
npm run dev:client            # Run client

# Build
npm run build

# Run the test suite (node:test, zero extra deps)
npm test

# Clean build artifacts
npm run clean

# Regenerate third-party licenses
npm run licenses
```

## Deployment

### Server Deployment

```bash
# On your VPS
git clone https://github.com/zt8h7cwrrc-coder/WShell.git && cd wshell
npm run build
node dist/cli/server.js user add admin -p <password>

# Keep running with pm2
pm2 start node -- dist/cli/server.js start
# Or use screen/tmux
screen -S wshelld node dist/cli/server.js start
```

### Firewall

Open port 7700 (or your custom port) on your VPS:

```bash
# Ubuntu/Debian
ufw allow 7700/tcp

# CentOS/RHEL
firewall-cmd --permanent --add-port=7700/tcp
firewall-cmd --reload
```

### Reverse Proxy (Optional)

For domain access with SSL, use Nginx as a WebSocket proxy:

```nginx
server {
    listen 443 ssl;
    server_name shell.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:7700;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

Then connect with:

```bash
wshell --server wss://shell.example.com admin@shell.example.com
```

## License

MIT — see [LICENSE](LICENSE)

Third-party licenses — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
