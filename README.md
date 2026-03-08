# clim — CLI Messenger

> Chat with humans and AI agents from your terminal.

clim is a terminal-based instant messenger. It connects to a [Pocket Claw](https://github.com/TeoVoss/pocket-claw) backend for user accounts, messaging (via Matrix protocol), and optional AI agent integration.

## Install

Requires **Node.js 22+**.

### From GitHub Release (recommended)

```bash
# Download and install the latest release
curl -fsSL https://github.com/TeoVoss/clim/releases/latest/download/clim-v0.6.0.tar.gz | tar xz
cd clim
npm install --production
npm link
```

### From source

```bash
git clone https://github.com/TeoVoss/clim.git
cd clim
npm install
npm run build
npm link
```

After installation, verify:

```bash
clim --version
# Expected output: 0.6.0
```

## Setup

### 1. Configure server (if not using default)

```bash
# Default server: https://pocket-claw-dev.vibelandapp.com
# To use a custom server:
clim config set provisioningUrl https://your-server.com
```

### 2. Create account or log in

```bash
# Option A: Email/password signup
clim signup --email you@example.com --password yourpassword

# Option B: Email/password login (existing account)
clim login --email you@example.com --password yourpassword

# Option C: Feishu OAuth login
clim config set feishuAppId YOUR_FEISHU_APP_ID
clim login --feishu
```

### 3. Start the daemon

The daemon runs in the background, syncing messages and handling AI agent requests.

```bash
clim daemon start
```

### 4. Verify everything works

```bash
clim status
# Should show: daemon running, Matrix connected
```

## Usage

### Chat

```bash
# Send a message
clim chat user@example.com "Hello!"

# Interactive chat shell
clim shell user@example.com

# View chat history
clim history user@example.com

# Check unread messages
clim unread

# List all conversations
clim rooms

# Search messages
clim search "meeting tomorrow"

# Stream incoming messages in real-time
clim watch
```

### Contacts

```bash
# Add a contact
clim contacts add friend@example.com

# List contacts
clim contacts list

# View pending requests
clim contacts requests

# Accept a request
clim contacts accept <request-id>
```

### Hooks (automation)

React to events automatically — webhooks, scripts, or log files.

```bash
# Log all messages to a file
clim hook add --name "logger" --filter "type=message.text" --log /tmp/messages.jsonl

# Run a script on incoming messages
clim hook add --name "handler" --filter "type=message.text" --exec "node handler.js"

# POST to a webhook
clim hook add --name "notify" --filter "type=message.text" \
  --webhook https://example.com/webhook

# List hooks
clim hook list
```

### AI Agents (optional)

If your account is connected to an AI agent platform (e.g. OpenClaw):

```bash
# Provision an AI agent
clim agent provision

# List agents
clim agent list

# Chat with your agent
clim chat @shadow "Summarize my unread messages"
```

### Daemon management

```bash
clim daemon start     # Start background sync
clim daemon stop      # Stop the daemon
clim daemon status    # Check daemon status
clim doctor           # Diagnose connection issues
```

### Account management

```bash
clim whoami                    # Show current identity
clim accounts list             # List all profiles
clim accounts switch <email>   # Switch active profile
clim logout                    # Log out
clim logout --purge            # Log out and delete all local data
```

## Configuration

Config is stored in `~/.clim/`:

| File | Purpose |
|------|---------|
| `config.json` | Server URL, Feishu App ID, preferences |
| `profiles/<email>/credentials.json` | Per-account auth tokens |
| `daemon.pid` | Running daemon process ID |
| `daemon.sock` | IPC socket for CLI ↔ daemon communication |

## Architecture

```
┌─────────┐        ┌──────────────┐        ┌────────┐
│  clim    │◀─ws──▶│  Provisioning │──────▶│ Synapse │
│  (CLI)   │       │   Service     │        │(Matrix) │
└─────────┘        └──────────────┘        └────────┘
     │
     └── daemon (background process)
           ├── Matrix sync (real-time messages)
           ├── Node client (AI agent tool execution)
           └── Hook engine (event automation)
```

## License

MIT
