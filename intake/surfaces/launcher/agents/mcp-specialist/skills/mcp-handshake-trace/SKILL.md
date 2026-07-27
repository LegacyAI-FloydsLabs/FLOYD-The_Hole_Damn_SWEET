---
name: mcp-handshake-trace
description: Drive and verify the MCP JSON-RPC lifecycle manually over STDIO or HTTP to isolate where an integration breaks. Use before blaming the client or declaring a server working.
---

# MCP Handshake Trace

Prove the protocol by speaking it directly, independent of any client.

STDIO servers — spawn and pipe JSON-RPC over stdin, read framed responses on
stdout (logs must be on stderr; if protocol noise appears on stdout, that is
the bug). Sequence:
1. `initialize` (send protocolVersion + client capabilities) → expect server
   capabilities + serverInfo.
2. `notifications/initialized` (no response expected).
3. `tools/list` → capture names, inputSchema, descriptions.
4. `tools/call` with valid args → capture result; then invalid args → expect a
   proper JSON-RPC error, not a crash or a hang.

HTTP servers — same JSON-RPC bodies over POST; verify: protocol-version
header, session id issuance/echo, response channel (JSON or SSE stream),
origin/auth handling, and reconnect. curl each step; capture status + body.

Record every request/response pair. The break is located at the first step
whose response is missing, malformed, timed out, or errored — report that step
number, not a guess. "Server process started" proves nothing until
`initialize` returns valid capabilities.
