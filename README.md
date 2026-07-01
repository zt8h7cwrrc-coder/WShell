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

After authentication, all messages are encrypted with libsodium:
- Key derived from auth token via `crypto_kdf`
- Each message uses a random 24-byte nonce
- XChaCha20-Poly1305 authenticated encryption

## Install

Requires Node.js >= 18.

```bash
git clone https://github.com/zt8h7cwrrc-coder/WShell.git
cd wshell
npm run build
```

`npm run build` automatically installs dependencies and compiles TypeScript.

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

### Client Commands (wshell)

```bash
# Interactive shell
wshell <user@host>
wshell <user@host:port>         # With port
wshell <name>                   # Use saved config

# Execute a single command
wshell <user@host> exec "ls -la"
wshell <user@host> exec "df -h"

# Upload file
wshell <user@host> put ./local.txt /remote/path.txt

# Download file
wshell <user@host> get /remote/path.txt ./local.txt

# Generate new token
wshell keygen

# Show help
wshell help
```

### Interactive Shell Commands

After connecting, use these commands in the interactive mode:

```
wshell> /shell                    # Open interactive terminal
wshell> /exec ls -la              # Execute command
wshell> /put ./file.txt /tmp/f    # Upload file
wshell> /get /tmp/f ./file.txt    # Download file
wshell> /quit                     # Exit
```

Direct input is sent to the shell session.

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
  -a, --auth <file>     Auth file path (default: ./wshell-auth.json)

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
| Token | Random generation, stored as SHA-256 fingerprints |
| Encryption | libsodium XChaCha20-Poly1305 |
| Key derivation | `crypto_kdf` from auth token |
| Message format | `[0x00 flag][4-byte nonce length][24-byte nonce][ciphertext]` |
| Before auth | Plaintext JSON |
| After auth | Fully encrypted |

## Project Structure

```
wshell/
├── src/
│   ├── cli/
│   │   ├── client.ts         # Client CLI
│   │   ├── server.ts         # Server CLI
│   │   └── start.ts          # Server entry point
│   ├── server/
│   │   └── index.ts          # TunnelServer class
│   ├── client/
│   │   └── index.ts          # TunnelClient class
│   ├── crypto/
│   │   ├── index.ts          # libsodium encryption
│   │   └── sodium-native.d.ts  # sodium-native types
│   └── shared/
│       ├── protocol.ts       # Message format
│       ├── auth.ts           # Authentication
│       └── config.ts         # Config management
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
