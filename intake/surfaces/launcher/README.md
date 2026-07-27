# Harness Launcher

Premium interactive CLI harness launcher with real-time terminal emulation.

## Features

- **15 CLI harnesses** dynamically loaded from `GET /harnesses`
- **Click to launch** — select any harness and it runs in real-time in the browser
- **Rock-solid stability** — xterm.js with atomic output, no streaming glitches
- **Auto-cleanup** — processes terminate cleanly on session close with zero artifacts
- **WebSocket heartbeat** — automatic stale-session detection (30s ping/pong)
- **Per-harness args** — pass custom arguments via the args input field
- **Session audit** — all launch/exit events written to structured JSON logs
- **Admin API** — monitor active sessions, force-terminate from CLI
- **Exponential-backoff reconnection** — survives network blips automatically
- **Premium design** — opulent Tokyo Night dark aesthetic with neon accents

## Prerequisites

- Node.js 16+ (check: `node -v`)
- npm (usually included with Node.js)
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential` and `python3` packages

## Installation

```bash
cd /Volumes/Storage/harness-launcher
npm install
```

This installs:
- `express` — HTTP server
- `node-pty` — pseudo-terminal support (native C++ module)
- `ws` — WebSocket server
- `uuid` — session identifiers
- `@xterm/xterm` + addons — terminal emulation

## Running

**Option 1: Using the start script**
```bash
bash /Volumes/Storage/harness-launcher/start.sh
```

**Option 2: Direct Node**
```bash
cd /Volumes/Storage/harness-launcher
PORT=11000 npm start
```

Then open your browser to:
```
http://localhost:11000
```

### Environment Variables

| Variable | Default     | Purpose                                                                 |
|----------|-------------|-------------------------------------------------------------------------|
| `PORT`   | `11000`     | HTTP server port                                                        |
| `HOST`   | `127.0.0.1` | Bind address. Set to `0.0.0.0` for LAN/iPad access (exposes admin API). |

> **Security:** Server binds to `127.0.0.1` (localhost only) by default. Set `HOST=0.0.0.0` only on trusted networks — this exposes `/admin/sessions` and `/admin/sessions/:id/kill` to all LAN hosts.

## Usage

1. **Select a harness** — click any harness card on the left
2. **View output** — terminal displays output in real-time via xterm.js
3. **Type commands** — terminal accepts keyboard input when focused
4. **Configure args** — enter custom args in the args field (shown for configurable harnesses)
5. **Close session** — click "Close Session" to terminate cleanly, or "Restart" to relaunch

## Architecture

### Backend (src/server.js)
- Express HTTP server + WebSocket
- node-pty for spawning PTY processes per session
- Structured JSON logging with session IDs (`{ts, level, sessionId, msg, …}`)
- Graceful SIGTERM/SIGINT shutdown with parallel session cleanup (5s timeout)
- Ping-pong heartbeat every 30s; missed pong → force-close stale session
- Max 10 concurrent sessions; reject with `SESSION_LIMIT` error above cap
- Per-session config: args array, env var overrides, cwd override

### Frontend (public/index.html)
- Dynamic harness cards fetched from `GET /harnesses` — no hardcoded list
- xterm.js with Tokyo Night theme, 10,000-line scrollback buffer
- Exponential-backoff reconnection on unexpected disconnect (1s → 2s → 4s → … → 60s cap)
- Inline terminal error display via ANSI red `[ERROR CODE]` text
- Per-harness args input field shown for configurable harnesses

### Shared (src/harnesses.js)
Single source of truth for all 15 harnesses. Edit here; both backend and frontend pick it up automatically.

### Cleanup
- Processes killed on session close (SIGTERM → 1s grace → SIGKILL)
- WebSocket cleanup on disconnect
- No leftover PTY processes or zombie processes
- Server graceful shutdown on Ctrl+C

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health + active session count |
| `GET` | `/harnesses` | List all available harnesses as JSON |
| `GET` | `/admin/sessions` | List active sessions (id, harness, command, duration) |
| `POST` | `/admin/sessions/:id/kill` | Force-terminate a session |

## WebSocket Protocol

Connect to `ws://localhost:11000`. Every message is a JSON object.

**Client → Server**

```json
{ "type": "launch",  "harness": "omp", "cols": 120, "rows": 40,
  "args": ["--verbose"], "cwd": "/path/to/dir" }
{ "type": "input",   "data": "hello\r" }
{ "type": "resize",  "cols": 80, "rows": 24 }
{ "type": "close" }
{ "type": "pong" }
```

**Server → Client**

```json
{ "type": "launched", "harness": "omp", "sessionId": "…",
  "command": "omp --verbose", "cwd": "/Users/…" }
{ "type": "output",   "data": "…output text…" }
{ "type": "exit",     "code": 0 }
{ "type": "error",    "code": "SESSION_LIMIT", "message": "…" }
```

Error codes: `PARSE_ERROR`, `MISSING_HARNESS`, `INVALID_HARNESS`, `SESSION_LIMIT`, `SPAWN_FAILED`, `WRITE_FAILED`, `RESIZE_FAILED`, `PROCESS_ERROR`, `UNKNOWN_MESSAGE`

## Troubleshooting

**node-pty won't compile?**

`node-pty` is a native module requiring a C++ compiler toolchain:

```bash
# macOS
xcode-select --install
npm install

# Rebuild after toolchain install
npm rebuild node-pty
```

**Port already in use?**
```bash
lsof -ti :11000 | xargs kill 2>/dev/null || true
PORT=11000 npm start
```

**Process stuck?**
```bash
pkill -f "node src/server.js"
pkill -f node-pty
```

## Performance

- Terminal latency: <100ms typical
- Memory: ~50MB per active session
- Max concurrent sessions: 10 (configurable via `MAX_CONCURRENT_SESSIONS`)
- Scrollback buffer: 10,000 lines per terminal
- Heartbeat interval: 30s (missed pong → 5s timeout → force-close)

## License

MIT
