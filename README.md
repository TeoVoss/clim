# clim — CLI Messenger

> Chat with humans and AI agents from your terminal.

`clim` is an instant messenger in your terminal. Sign up, add contacts, chat in real-time. Connect any AI agent to receive message notifications — clim is the bridge between your conversations and your agents.

## Install

```bash
npm install -g clim
```

Requires Node.js 18+.

## Quick Start

```bash
# 1. Create your account
clim signup --email alice@example.com --password mypassword

# 2. Start the background daemon (handles message sync)
clim daemon start

# 3. Add a friend
clim contacts add bob@example.com

# 4. Once they accept, start chatting
clim chat bob@example.com "Hey, what are you working on?"

# 5. Open an interactive shell for real-time conversation
clim shell bob@example.com
```

## Commands

### Account

| Command | Description |
|---------|-------------|
| `clim signup --email <email> --password <pw>` | Create a new account |
| `clim login --email <email> --password <pw>` | Log in to existing account |
| `clim status` | Show connection status and daemon state |
| `clim accounts list` | List all logged-in profiles |
| `clim accounts switch <email>` | Switch active profile |

### Contacts

| Command | Description |
|---------|-------------|
| `clim contacts list` | List your contacts |
| `clim contacts add <email>` | Send a contact request |
| `clim contacts accept <id>` | Accept an incoming request |
| `clim contacts reject <id>` | Reject an incoming request |
| `clim contacts requests` | Show pending requests |

### Chat

| Command | Description |
|---------|-------------|
| `clim chat <target> [message]` | Send a message |
| `clim shell <target>` | Interactive chat shell |
| `clim history <target>` | View chat history |
| `clim rooms` | List all rooms |
| `clim unread` | Show unread messages |
| `clim search <query>` | Search messages |
| `clim watch` | Stream incoming messages |

### Daemon

| Command | Description |
|---------|-------------|
| `clim daemon start` | Start background sync |
| `clim daemon stop` | Stop the daemon |
| `clim daemon status` | Check daemon status |
| `clim doctor` | Diagnose connection issues |

### Hooks

Hooks let you react to events automatically — send webhooks, run scripts, or log to files whenever messages arrive.

| Command | Description |
|---------|-------------|
| `clim hook add [options]` | Create a new hook |
| `clim hook list` | List all hooks |
| `clim hook remove <id>` | Remove a hook |
| `clim hook enable <id>` | Enable a hook |
| `clim hook disable <id>` | Disable a hook |
| `clim hook test <id>` | Send a test event to a hook |
| `clim hook history` | Show recent hook triggers |

#### Examples

```bash
# Log all incoming messages to a file
clim hook add --name "log-msgs" --filter "type=message.text" --log /tmp/messages.jsonl

# POST to a webhook when anyone messages you
clim hook add --name "slack-notify" --filter "type=message.text" \
  --webhook https://hooks.slack.com/services/T.../B.../xxx

# Run a script when a specific person messages
clim hook add --name "bob-handler" --filter "type=message.text,sender=@bob*" \
  --exec "node my-handler.js"

# Webhook with HMAC-SHA256 signature verification
clim hook add --name "secure-hook" --filter "type=message.*" \
  --webhook https://example.com/webhook --secret my-secret-key
```

#### Filters

Filters use `key=pattern` pairs separated by commas. Supports glob patterns (`*`).

| Key | Description | Example |
|-----|-------------|---------|
| `type` | Event type | `type=message.text`, `type=message.*` |
| `sender` | Sender Matrix ID | `sender=@alice*` |
| `senderDisplayName` | Display name | `senderDisplayName=Bob` |
| `roomId` | Room ID | `roomId=!abc:server.com` |
| `body` | Message body (from payload) | `body=*hello*` |

#### Hook Actions

Each hook has one action:

- **`--webhook <url>`** — HTTP POST event JSON. Optional: `--method PUT`, `--header "Key: Value"`, `--secret <key>` (adds `X-Clim-Signature` HMAC-SHA256 header)
- **`--exec <command>`** — Run command with event JSON on stdin
- **`--log [path]`** — Append NDJSON to file (or stdout if no path)
### AI Agents (Optional)

clim can connect to AI agent platforms. Agents receive message notifications through clim and can respond in your conversations.

| Command | Description |
|---------|-------------|
| `clim agent provision` | Set up an AI agent |
| `clim agent list` | List connected agents |
| `clim chat @agent "hello"` | Chat with an agent |

## Configuration

clim stores config in `~/.clim/`:

- `config.json` — Server URL and preferences
- `profiles/` — Per-account credentials

### Custom Server

```bash
clim config set provisioningUrl http://localhost:3000
```

## Architecture

```
┌─────────┐        ┌──────────────┐        ┌────────┐
│  clim    │◀─ws──▶│  Provisioning │──────▶│ Synapse │
│  (CLI)   │       │   Service     │        │(Matrix) │
└─────────┘        └──────────────┘        └────────┘
```

clim is built on the [Matrix](https://matrix.org) protocol for messaging. The daemon maintains a persistent sync connection and delivers messages in real-time.

## Development

```bash
git clone https://github.com/anthropic/pocket-claw
cd pocket-claw/packages/chatcli

npm install
npm run build

node dist/cli.mjs signup --email test@example.com --password 123456
```

## License

MIT
