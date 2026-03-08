# clim

CLI messenger for [OpenClaw](https://github.com/open-claw/openclaw).

## Install

Requires **Node.js 22+**.

```bash
curl -fsSL https://github.com/TeoVoss/clim/releases/latest/download/clim-v0.6.0.tar.gz | tar xz
cd clim
npm install --production
npm link
```

## Setup

```bash
# Configure server (default: https://pocket-claw-dev.vibelandapp.com)
clim config set provisioningUrl https://your-server.com

# Log in (pick one)
clim login --email you@example.com --password yourpassword
clim login --feishu   # requires: clim config set feishuAppId YOUR_APP_ID

# Start daemon
clim daemon start

# Verify
clim status
```

## License

MIT
