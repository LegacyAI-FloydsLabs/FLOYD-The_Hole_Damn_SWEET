# TerminalOne ↔ ShellFish Parity Backlog

## ShellFish features mapped to a browser terminal emulator

| # | ShellFish capability | What we can implement in TerminalOne | Files likely touched |
|---|----------------------|--------------------------------------|----------------------|
| 1 | Customizable key bar (assign keys, snippets) | Draggable / configurable key-bar buttons with settings persistence | public/index.html, public/features/keybar-config.mjs |
| 2 | Snippets toolbar | Expand existing snippets feature (folders, import/export) | public/features/snippets.mjs |
| 3 | OSC 52 clipboard integration | Server→client clipboard bridge via xterm OSC 52 handler | src/server.js, public/index.html |
| 4 | OSC 777 local notifications | Map OSC 777 escape sequence to browser Notification API | public/index.html |
| 5 | URL / filename detection and tap-to-open | Use xterm WebLinksAddon; add filename hover/click menu | public/index.html, public/features/links.mjs |
| 6 | Search in terminal | Already present via addon-search; enhance (regex, case) | public/features/search.mjs |
| 7 | Text selection & copy | xterm selection is native; add select-all and copy-toast | public/features/clipboard.mjs |
| 8 | Fullscreen / no-distraction mode | Existing wake-fullscreen; add dedicated fullscreen button | public/features/wake-fullscreen.mjs |
| 9 | Pinch-to-zoom font size | Gesture handler that changes terminal font size | public/features/fontsize.mjs or new zoom.mjs |
| 10 | Font size / font family settings | Existing fontsize; add font-family selector | public/features/fontsize.mjs |
| 11 | Cursor style / blink settings | Expose xterm cursor options in settings | public/index.html |
| 12 | Bell / visual bell settings | Toggle audible/visual bell | public/index.html |
| 13 | Scrollback buffer size | Expose xterm scrollback setting | public/index.html |
| 14 | Session rename / multiple named sessions | UI to label sessions; list and switch | public/index.html, src/server.js |
| 15 | Connection status indicator with details | Enhanced footer: latency, uptime, shell type | public/index.html, src/server.js |
| 16 | Reconnect on disconnect (auto-resume) | Already partially present; harden with backoff | public/index.html |
| 17 | Hardware keyboard shortcuts (Ctrl+Shift+C/V/T) | Bind Ctrl+Shift+C copy, Ctrl+Shift+V paste, Ctrl+Shift+T new tab | public/index.html |
| 18 | New tab / session switcher | Multi-session tabs in header | public/index.html, src/server.js |
| 19 | Export terminal output | Save current scrollback as .txt | public/features/export.mjs |
| 20 | Settings import/export | JSON export/import of settings (themes, keybar, snippets) | public/index.html |

## Out of scope (requires native iOS/macOS)
- SSH client / host management (we run a local PTY; remote hosts are out of scope)
- Secure Enclave / FIDO2 / certificates
- iCloud Keychain sync
- Files.app / Finder integration
- Mosh protocol
- tmux GUI thumbnails / Handoff
- Shortcuts integration
- Widgets / Live Activities
- Drag-and-drop of real files over SSH
- Cloud server launch (DigitalOcean / Hetzner)

## Implementation order
1–20 as listed, because each builds on the T1 extension framework already in public/index.html.
