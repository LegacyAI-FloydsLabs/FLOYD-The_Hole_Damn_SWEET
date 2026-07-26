#!/usr/bin/env python3
"""
Floyd's Labs TTY Bridge -- Native Messaging Host v4.7 (Hardened + MCP Bridge)

Bridges a PTY shell to Chrome's native messaging protocol.
LLM agents communicate via OSC 7701/7702 escape sequences.

v4.7 adds: MCP subprocess bridge — spawns an MCP server (JSON-RPC 2.0 over
stdio) as a managed child process and translates between Chrome native
messaging wire format (4-byte length-prefixed) and MCP stdio format
(newline-delimited JSON-RPC 2.0).

Protocol (PTY / OSC):
  Agent -> Browser:  \x1b]7701;{json}\x07
  Browser -> Agent:  \x1b]7702;{json}\x07
  Large payloads:    Written to temp file, path sent in response

Protocol (MCP Bridge):
  Chrome -> MCP:     { "type": "mcp_tool_call", ... }  →  newline-delimited JSON-RPC
  MCP -> Chrome:     newline-delimited JSON-RPC          →  { "type": "mcp_...", ... }

Wire format (Chrome native messaging):
  4-byte little-endian uint32 length prefix, followed by UTF-8 JSON.
"""

import orjson
import os
import pty
import re
import secrets
import selectors
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import atexit
import shutil
from typing import Optional

CHROME_NATIVE_MSG_MAX = 1024 * 1024  # 1 MB Chrome native messaging hard limit
MCP_MSG_MAX = 4 * 1024 * 1024  # 4 MB — MCP servers can return large payloads (e.g. screenshots)
LARGE_PAYLOAD_THRESHOLD = 128 * 1024  # 128 KB — spill to temp file above this
PTY_READ_SIZE = 65536  # 64 KB — reduces syscall overhead
OSC_MAX_BODY = 256 * 1024  # 256 KB cap on buffered OSC body (DoS guard)

OSC_START = "\x1b]"
OSC_END_BEL = "\x07"
OSC_END_ST = "\x1b\\"  # ST terminator (ESC \) — common in OSC 8 hyperlinks
OSC_COMMAND_PREFIX = "7701;"
OSC_RESPONSE_PREFIX = "7702;"

_SESSION_ID = secrets.token_hex(8)
TEMP_DIR = os.path.join(tempfile.gettempdir(), f"floyd-{_SESSION_ID}")
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")

# ---------------------------------------------------------------------------
# Process Supervisor — manages background and orphaned processes
# ---------------------------------------------------------------------------


class ProcessSupervisor:
    """
    Tracks and manages child processes to prevent zombies and hangs.
    """

    def __init__(self):
        self._processes: dict[int, subprocess.Popen[str]] = {}
        self._lock = threading.Lock()

    def add_process(self, proc: subprocess.Popen[str]):
        with self._lock:
            self._processes[proc.pid] = proc

    def check_zombies(self):
        """Reaps finished processes."""
        with self._lock:
            finished = []
            for pid, proc in self._processes.items():
                if proc.poll() is not None:
                    finished.append(pid)
            for pid in finished:
                del self._processes[pid]

    def terminate_all(self):
        """Kill everything on shutdown."""
        with self._lock:
            for pid, proc in self._processes.items():
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            self._processes.clear()


supervisor = ProcessSupervisor()

# ---------------------------------------------------------------------------
# MCP Bridge Configuration
# ---------------------------------------------------------------------------

MCP_SERVER_PATH = os.environ.get(
    "MCP_SERVER_PATH",
    "/Volumes/Storage/A-TEAM/open-anvil/mcp-server/server.js",
)
MCP_SPAWN_TIMEOUT = 5  # seconds to wait for MCP server to start
MCP_RESTART_DELAY = 2  # seconds before restarting crashed MCP server
MCP_MAX_RESTARTS = 5  # max restart attempts before giving up

# ---------------------------------------------------------------------------
# MCP Bridge — spawns and manages an MCP server subprocess
# ---------------------------------------------------------------------------


class MCPBridge:
    """
    Lazily-spawned MCP server subprocess with wire format translation.

    Translates between:
      - Chrome native messaging: 4-byte LE uint32 length prefix + UTF-8 JSON
      - MCP stdio: newline-delimited JSON-RPC 2.0

    Message routing uses "mcp_" prefix on type field:
      - Chrome → MCP: messages with type "mcp_*" are forwarded (prefix stripped)
      - MCP → Chrome: all outgoing messages get "mcp_" prefix on their type
    """

    def __init__(self, server_path: str, shutdown_event: threading.Event):
        self.server_path = server_path
        self.shutdown_event = shutdown_event
        self.proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()  # protects spawn/restart state
        self._stdin_lock = threading.Lock()  # protects stdin writes
        self._restart_count = 0
        self._reader_alive = False
        self._validated_path = False

    def _validate_path(self) -> bool:
        """Validate server_path exists and is a regular file (once)."""
        if self._validated_path:
            return True
        if not os.path.isfile(self.server_path):
            sys.stderr.write(f"MCP: server not found at {self.server_path}\n")
            return False
        self._validated_path = True
        return True

    def _close_proc_pipes(self):
        """Safely close proc stdin/stdout/stderr (prevent ResourceWarning/leaks)."""
        if not self.proc:
            return
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    def _spawn(self) -> bool:
        """Spawn the MCP server subprocess. Thread-safe."""
        with self._lock:
            # Fast path: already running
            if self.proc and self.proc.poll() is None:
                return True

            # Clean up previous proc's pipes if any
            self._close_proc_pipes()
            self.proc = None

            if self._restart_count >= MCP_MAX_RESTARTS:
                sys.stderr.write(
                    f"MCP: max restarts ({MCP_MAX_RESTARTS}) exceeded, giving up\n"
                )
                return False

            if not self._validate_path():
                return False

            try:
                mcp_env = os.environ.copy()
                mcp_env["MCP_TRANSPORT"] = "stdio"

                self.proc = subprocess.Popen(
                    ["node", self.server_path],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    preexec_fn=os.setsid,
                    env=mcp_env,
                )
                supervisor.add_process(self.proc)
                self._restart_count += 1
                sys.stderr.write(
                    f"MCP: spawned server (pid={self.proc.pid}, "
                    f"restart #{self._restart_count})\n"
                )

                # Start stdout reader thread
                self._reader_alive = True
                threading.Thread(target=self._read_loop, daemon=True).start()

                # Start stderr drain thread (prevent pipe buffer deadlock)
                threading.Thread(target=self._stderr_drain, daemon=True).start()

                return True

            except Exception as e:
                sys.stderr.write(f"MCP: spawn failed: {e}\n")
                self.proc = None
                return False

    def _read_loop(self):
        """
        Read newline-delimited JSON from MCP stdout.
        Translate to Chrome native messaging format (4-byte prefix)
        and forward. Prefix type with "mcp_" for extension routing.
        """
        # Capture proc reference at thread start to avoid races with respawn
        proc = self.proc
        if not proc:
            return

        try:
            while not self.shutdown_event.is_set():
                line = proc.stdout.readline()
                if not line:
                    if not self.shutdown_event.is_set():
                        sys.stderr.write(
                            "MCP: stdout EOF, server may have crashed\n"
                        )
                    break

                line = line.strip()
                if not line:
                    continue

                # Guard against oversized MCP output
                if len(line) > MCP_MSG_MAX:
                    sys.stderr.write(
                        f"MCP: oversized stdout line ({len(line)} bytes), "
                        f"max {MCP_MSG_MAX}\n"
                    )
                    continue

                try:
                    msg = orjson.loads(line)
                except Exception:
                    sys.stderr.write(
                        f"MCP: unparseable stdout line: {line[:200]}\n"
                    )
                    continue

                if not isinstance(msg, dict):
                    sys.stderr.write(
                        f"MCP: stdout not a dict: {type(msg).__name__}\n"
                    )
                    continue

                # ── Extension tool_call translation ────────────────────────
                # server.js sends tool calls as JSON-RPC notifications with
                # method "anvil/tool_call". Translate to extension format.
                method = msg.get("method")
                if method == "anvil/tool_call":
                    params = msg.get("params", {})
                    translated = {
                        "type": "mcp_tool_call",
                        "requestId": params.get("id"),
                        "tool": params.get("tool"),
                        "args": params.get("args", {}),
                    }
                    send_message(translated)
                    continue

                # ── Perception init signal ─────────────────────────────────
                if method == "anvil/perception_init":
                    send_message({
                        "type": "mcp_perception_init",
                        "version": msg.get("params", {}).get("version"),
                    })
                    continue

                # Prefix the type field with "mcp_" for extension routing
                msg_type = msg.get("type")
                if msg_type and isinstance(msg_type, str):
                    msg["type"] = f"mcp_{msg_type}"
                elif "method" in msg:
                    # JSON-RPC 2.0 notification/request — wrap in envelope
                    msg = {
                        "type": "mcp_message",
                        "payload": msg,
                    }
                elif "result" in msg or "error" in msg:
                    # JSON-RPC 2.0 response — wrap in envelope
                    msg = {
                        "type": "mcp_response",
                        "payload": msg,
                    }

                send_message(msg)

        except Exception as e:
            if not self.shutdown_event.is_set():
                sys.stderr.write(f"MCP: read error: {e}\n")
        finally:
            self._reader_alive = False

    def _stderr_drain(self):
        """Drain MCP stderr to prevent pipe buffer deadlock. Log to host stderr."""
        proc = self.proc
        if not proc:
            return
        try:
            while not self.shutdown_event.is_set():
                line = proc.stderr.readline()
                if not line:
                    break
                sys.stderr.write(f"MCP stderr: {line.rstrip()}\n")
        except Exception:
            pass

    def send(self, msg: dict) -> bool:
        """
        Send a message to MCP stdin.

        Incoming Chrome messages with "mcp_" type prefix get the prefix
        stripped before forwarding. The result is written as a single
        line of JSON + newline (MCP stdio format).

        Returns True if sent successfully, False otherwise.
        """
        # Spawn under lock — ensures proc is either running or we know it failed
        if not self._spawn():
            return False

        # Strip "mcp_" prefix before forwarding to MCP server
        msg = dict(msg)
        msg_type = msg.get("type", "")
        if isinstance(msg_type, str) and msg_type.startswith("mcp_"):
            msg["type"] = msg_type[4:]
            if not msg["type"]:
                del msg["type"]

        try:
            with self._stdin_lock:
                proc = self.proc
                if proc and proc.poll() is None:
                    proc.stdin.write(orjson.dumps(msg).decode() + "\n")
                    proc.stdin.flush()
                    return True
                else:
                    return False
        except BrokenPipeError:
            sys.stderr.write("MCP: BrokenPipeError on send — server likely crashed\n")
            return False
        except Exception as e:
            sys.stderr.write(f"MCP: send failed: {e}\n")
            return False

    def is_alive(self) -> bool:
        try:
            return self.proc is not None and self.proc.poll() is None
        except Exception:
            return False

    def shutdown(self):
        """Terminate the MCP server subprocess and close pipes."""
        with self._lock:
            proc = self.proc
            self.proc = None

        if proc and proc.poll() is None:
            sys.stderr.write(f"MCP: shutting down (pid={proc.pid})\n")
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            except (ProcessLookupError, OSError):
                pass  # already dead
            finally:
                self._close_proc_pipes()

def _drain_bytes(stream, n: int):
    """Drain exactly n bytes from a stream (used to skip oversized payloads)."""
    remaining = n
    while remaining > 0:
        chunk = stream.read(min(remaining, 65536))
        if not chunk:
            break
        remaining -= len(chunk)


# ---------------------------------------------------------------------------
# Chrome native messaging I/O (stdin/stdout are the Chrome channel)
# ---------------------------------------------------------------------------

_stdout_lock = threading.Lock()


def _read_exact(stream, n: int) -> Optional[bytes]:
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def read_message():
    """Read a length-prefixed message from stdin."""
    header = _read_exact(sys.stdin.buffer, 4)
    if not header:
        return None
    length = struct.unpack("<I", header)[0]
    # CRITICAL: Chrome hard-limits native messages to 1 MB.
    # A malicious or buggy sender could send a 4 GB length field.
    if length > CHROME_NATIVE_MSG_MAX:
        sys.stderr.write(
            f"MSG: rejected oversized message ({length} bytes, "
            f"max {CHROME_NATIVE_MSG_MAX})\n"
        )
        # Drain the oversized payload to keep the stream in sync
        _drain_bytes(sys.stdin.buffer, length)
        return None
    data = _read_exact(sys.stdin.buffer, length)
    if not data:
        return None
    try:
        return orjson.loads(data)
    except Exception:
        sys.stderr.write(f"MSG: unparseable JSON payload ({length} bytes)\n")
        return None


def send_message(message):
    """Send a length-prefixed JSON message to stdout."""
    with _stdout_lock:
        try:
            encoded = orjson.dumps(message)
        except Exception:
            sys.stderr.write(f"MSG: unserializable message: {type(message)}\n")
            return
        if len(encoded) > CHROME_NATIVE_MSG_MAX:
            sys.stderr.write(
                f"MSG: outbound too large ({len(encoded)} bytes), "
                f"max {CHROME_NATIVE_MSG_MAX}\n"
            )
            return
        sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


# ---------------------------------------------------------------------------
# OSC Parser — handles escape sequences embedded in PTY stream
# ---------------------------------------------------------------------------


class OSCParser:
    """
    State machine to extract OSC 7701 (Command) and 7702 (Response)
    sequences from the PTY output stream.
    """

    def __init__(self):
        self.buffer = ""
        self.in_osc = False

    def feed(self, char: str) -> Optional[tuple[str, dict]]:
        if not self.in_osc:
            if char == "\x1b":
                self.buffer = char
            elif char == "]" and self.buffer == "\x1b":
                self.in_osc = True
                self.buffer = ""
            else:
                self.buffer = ""
            return None

        # Check for terminators
        if char == OSC_END_BEL or self.buffer.endswith("\x1b\\"):
            raw = self.buffer.rstrip("\x1b\\")
            self.in_osc = False
            self.buffer = ""

            if raw.startswith(OSC_COMMAND_PREFIX):
                try:
                    body = raw[len(OSC_COMMAND_PREFIX) :]
                    return ("command", orjson.loads(body))
                except Exception:
                    pass
            elif raw.startswith(OSC_RESPONSE_PREFIX):
                try:
                    body = raw[len(OSC_RESPONSE_PREFIX) :]
                    return ("response", orjson.loads(body))
                except Exception:
                    pass
            return None

        self.buffer += char
        if len(self.buffer) > OSC_MAX_BODY:
            self.in_osc = False
            self.buffer = ""
        return None


# ---------------------------------------------------------------------------
# Bridge Logic
# ---------------------------------------------------------------------------


def pty_to_chrome(master_fd, parser, shutdown_event):
    """Read from PTY, detect OSC commands, send everything else to Chrome."""
    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ)

    while not shutdown_event.is_set():
        events = selector.select(timeout=0.1)
        if not events:
            continue

        try:
            data = os.read(master_fd, PTY_READ_SIZE)
            if not data:
                break

            decoded = data.decode("utf-8", errors="replace")
            output_buf = ""

            for char in decoded:
                osc = parser.feed(char)
                if osc:
                    msg_type, body = osc
                    if msg_type == "command":
                        request_id = body.get("id", "req_" + secrets.token_hex(4))
                        if body.get("type") == "ragbot_request":
                            send_message(
                                {
                                    "type": "ragbot_request",
                                    "requestId": request_id,
                                    "query": body.get("query", ""),
                                }
                            )
                        else:
                            # Agent is calling a browser tool
                            send_message(
                                {
                                    "type": "tool_call",
                                    "requestId": request_id,
                                    "tool": body.get("tool"),
                                    "args": body.get("args", {}),
                                }
                            )
                    continue

                if not parser.in_osc:
                    output_buf += char

            if output_buf:
                send_message({"type": "pty_output", "data": output_buf})

        except OSError:
            break

    shutdown_event.set()


def chrome_to_pty(master_fd, msg):
    """Handle messages coming from Chrome."""
    msg_type = msg.get("type")

    def write_osc_response(request_id, ok, result, error):
        payload = {"id": request_id, "ok": ok}
        if result is not None:
            payload["result"] = result
        if error is not None:
            payload["error"] = error

        serialized = orjson.dumps(payload)

        if len(serialized) > LARGE_PAYLOAD_THRESHOLD:
            if not _SAFE_ID_RE.match(str(request_id)):
                request_id = secrets.token_hex(8)
            os.makedirs(TEMP_DIR, mode=0o700, exist_ok=True)
            filepath = os.path.join(TEMP_DIR, f"result_{request_id}.json")
            fd = os.open(filepath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, serialized)
            finally:
                os.close(fd)
            pointer = orjson.dumps(
                {"id": request_id, "ok": bool(ok), "file": filepath}
            ).decode("utf-8")
            osc_seq = f"{OSC_START}{OSC_RESPONSE_PREFIX}{pointer}{OSC_END_BEL}"
        else:
            osc_seq = f"{OSC_START}{OSC_RESPONSE_PREFIX}{serialized.decode('utf-8')}{OSC_END_BEL}"

        try:
            os.write(master_fd, osc_seq.encode("utf-8"))
        except OSError:
            pass

    if msg_type == "tool_response":
        request_id = msg.get("requestId", "unknown")
        ok = msg.get("success", False)
        result = msg.get("result", None)
        error = msg.get("error", None)
        write_osc_response(request_id, ok, result, error)

    elif msg_type == "ragbot_response":
        request_id = msg.get("requestId", "unknown")
        ok = msg.get("success", False)
        result = msg.get("result", None)
        error = msg.get("error", None)
        write_osc_response(request_id, ok, result, error)

    elif msg_type == "pty_input":
        data = msg.get("data", "")
        if isinstance(data, str) and data:
            try:
                os.write(master_fd, data.encode("utf-8"))
            except OSError:
                pass

    elif msg_type in ("browser_refresh", "execute_shell") or msg.get("tool") == "execute_shell":
        request_id = str(msg.get("requestId", "shell_" + str(int(time.time()))))
        command = str(msg.get("command", msg.get("args", {}).get("command", "")))
        if not command:
            send_message(
                {
                    "type": "tool_response",
                    "requestId": request_id,
                    "success": False,
                    "error": "Empty command",
                }
            )
            return

        def run_shell():
            try:
                # Guard: cap command length to prevent abuse
                if len(command) > 10000:
                    send_message(
                        {
                            "type": "tool_response",
                            "requestId": request_id,
                            "success": False,
                            "error": "Command too long (max 10000 chars)",
                        }
                    )
                    return

                proc = subprocess.Popen(
                    ["/bin/bash", "-c", command],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    preexec_fn=os.setsid,
                )
                supervisor.add_process(proc)
                stdout, stderr = proc.communicate(timeout=30)

                # Truncate large output to prevent memory abuse
                _MAX_SHELL_OUTPUT = 256 * 1024
                if len(stdout) > _MAX_SHELL_OUTPUT:
                    stdout = stdout[:_MAX_SHELL_OUTPUT] + "\n... truncated"
                if len(stderr) > _MAX_SHELL_OUTPUT:
                    stderr = stderr[:_MAX_SHELL_OUTPUT] + "\n... truncated"

                send_message(
                    {
                        "type": "tool_response",
                        "requestId": request_id,
                        "success": proc.returncode == 0,
                        "result": {
                            "stdout": stdout,
                            "stderr": stderr,
                            "exitCode": proc.returncode,
                        },
                    }
                )
            except subprocess.TimeoutExpired:
                supervisor.terminate_all()
                send_message(
                    {
                        "type": "tool_response",
                        "requestId": request_id,
                        "success": False,
                        "error": "Command timed out after 30s",
                    }
                )
            except Exception as e:
                send_message(
                    {
                        "type": "tool_response",
                        "requestId": request_id,
                        "success": False,
                        "error": str(e),
                    }
                )

        threading.Thread(target=run_shell, daemon=True).start()


def cleanup(pid):
    """Cleanup temp files and child processes."""
    supervisor.terminate_all()
    if os.path.exists(TEMP_DIR):
        try:
            shutil.rmtree(TEMP_DIR)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    os.makedirs(TEMP_DIR, mode=0o700, exist_ok=True)

    # Determine shell
    shell = os.environ.get("SHELL", "/bin/zsh")

    # Open a PTY pair
    master_fd, slave_fd = pty.openpty()

    def _strip_esc(s):
        return re.sub(
            r"\x1b[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\x07",
            "",
            s,
        )

    def _parse_env(output):
        return dict(
            line.split("=", 1)
            for line in _strip_esc(output).strip().split("\n")
            if "=" in line and not line.startswith("_=")
        )

    seed = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": os.path.expanduser("~"),
        "USER": os.environ.get("USER", ""),
        "SHELL": shell,
        "TERM": "dumb",
    }
    try:
        # Login shell: clean PATH from .zprofile
        r1 = subprocess.run(
            [shell, "-l", "-c", "printenv"],
            capture_output=True,
            text=True,
            timeout=3,
            env=seed,
        )
        env1 = _parse_env(r1.stdout)
    except Exception as e:
        sys.stderr.write(f"Login shell env failed: {e}\n")
        env1 = {}

    try:
        # Interactive login: .zshrc vars (API keys, custom vars)
        r2 = subprocess.run(
            [shell, "-li", "-c", "printenv"],
            capture_output=True,
            text=True,
            timeout=3,
            env=seed,
        )
        env2 = _parse_env(r2.stdout)
    except Exception as e:
        sys.stderr.write(f"Interactive shell env failed: {e}\n")
        env2 = {}

    # Merge: interactive fills gaps, login wins for shared keys (cleaner PATH)
    env = {**env2, **env1}
    if not env or "PATH" not in env:
        env = os.environ.copy()

    # Fill in session vars that macOS injects but shells don't export
    if "TMPDIR" not in env:
        env["TMPDIR"] = tempfile.gettempdir()
    if "SSH_AUTH_SOCK" not in env:
        try:
            r = subprocess.run(
                ["launchctl", "getenv", "SSH_AUTH_SOCK"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if r.stdout.strip():
                env["SSH_AUTH_SOCK"] = r.stdout.strip()
        except Exception:
            pass

    # Overlay Floyd-specific vars
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["LANG"] = "en_US.UTF-8"
    env["FLOYD_TTY_BRIDGE"] = "4.7"
    env["FLOYD_TOOLS_AVAILABLE"] = "1"

    workspace_sdk = os.path.join(os.path.dirname(os.path.abspath(__file__)), "floyd-tools.sh")
    if os.path.exists(workspace_sdk):
        env["FLOYD_TOOLS_SDK"] = workspace_sdk
    else:
        env["FLOYD_TOOLS_SDK"] = "/usr/local/share/floyd/floyd-tools.sh"

    child = subprocess.Popen(
        [shell, "-l"],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
        preexec_fn=os.setsid,
        env=env,
    )

    # Close the slave fd in the parent — the child owns it now
    os.close(slave_fd)

    # Initialize shutdown event and MCP bridge BEFORE signal handlers
    # (signals can fire at any time — handler must not hit NameError)
    shutdown_event = threading.Event()
    mcp_bridge = MCPBridge(MCP_SERVER_PATH, shutdown_event)

    # Register cleanup
    atexit.register(cleanup, child.pid)

    def sigterm_handler(_sig, _frame):
        shutdown_event.set()
        mcp_bridge.shutdown()
        cleanup(child.pid)
        # os._exit avoids _Py_Finalize race with blocked chrome_reader thread
        os._exit(0)

    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT, sigterm_handler)

    # Announce readiness
    send_message(
        {
            "type": "ready",
            "version": "4.7",
            "pid": child.pid,
            "shell": shell,
        }
    )

    # Start the PTY reader thread
    parser = OSCParser()

    reader_thread = threading.Thread(
        target=pty_to_chrome,
        args=(master_fd, parser, shutdown_event),
        daemon=True,
    )
    reader_thread.start()

    # Watchdog thread: reaps finished background processes
    def watchdog():
        while not shutdown_event.is_set():
            supervisor.check_zombies()
            time.sleep(5)

    threading.Thread(target=watchdog, daemon=True).start()

    # File Watcher thread: triggers browser refresh on file changes
    def file_watcher():
        # Watch the directory where the native host is located as a default project root
        watch_path = os.path.dirname(os.path.abspath(__file__))
        last_mtimes = {}
        _MAX_WATCH_DEPTH = 3  # prevent walking into deep directory trees
        _MAX_WATCH_FILES = 5000  # cap memory usage

        while not shutdown_event.is_set():
            changed = False
            try:
                for root, dirs, files in os.walk(watch_path):
                    # Prune deep directories
                    depth = root[len(watch_path):].count(os.sep)
                    if depth >= _MAX_WATCH_DEPTH:
                        dirs.clear()
                        continue

                    if ".git" in dirs: dirs.remove(".git")
                    if "node_modules" in dirs: dirs.remove("node_modules")

                    for f in files:
                        if len(last_mtimes) >= _MAX_WATCH_FILES:
                            break
                        if f.endswith((".html", ".css", ".js", ".py", ".sh")):
                            path = os.path.join(root, f)
                            mtime = os.path.getmtime(path)
                            if path in last_mtimes and mtime > last_mtimes[path]:
                                changed = True
                            last_mtimes[path] = mtime

                if changed:
                    send_message({"type": "file_changed", "path": watch_path})
            except Exception:
                pass
            time.sleep(1)  # Poll every 1s

    threading.Thread(target=file_watcher, daemon=True).start()

    # Track whether the Open Anvil extension has registered on this pipe.
    # When registered, tool_response is routed to MCP subprocess instead of PTY.
    anvil_registered = False

    def chrome_reader():
        nonlocal anvil_registered
        while not shutdown_event.is_set():
            try:
                msg = read_message()
                if msg is None:
                    break
                if not isinstance(msg, dict):
                    continue
                msg_type = msg.get("type", "")

                # --- Short-circuit: ping/pong (no MCP subprocess involved) ---
                if msg_type == "ping":
                    send_message({"type": "pong"})
                    continue

                # --- Extension registration signal ---
                if msg_type == "anvil_register":
                    nonlocal anvil_registered
                    anvil_registered = True
                    reg_data = msg.get("data", {})
                    if isinstance(reg_data, dict):
                        sys.stderr.write(
                            f"MCP: extension registered "
                            f"(version={reg_data.get('version', '?')}, "
                            f"channel={reg_data.get('channel', '?')})\n"
                        )
                    # Request fresh perception snapshots from extension
                    send_message({"type": "mcp_perception_init"})
                    continue

                # --- Route mcp_* messages to MCP bridge ---
                if isinstance(msg_type, str) and msg_type.startswith("mcp_"):
                    # Perception events from extension → translate to JSON-RPC
                    if msg_type.startswith("mcp_perception"):
                        translated = {
                            "jsonrpc": "2.0",
                            "method": "anvil/perception",
                            "params": {
                                "type": msg_type[4:],  # strip "mcp_" prefix
                                "tabId": msg.get("tabId"),
                                "timestamp": msg.get("timestamp"),
                            },
                        }
                        # Copy remaining fields to params
                        for k, v in msg.items():
                            if k not in ("type", "tabId", "timestamp"):
                                translated["params"][k] = v
                        mcp_bridge.send(translated)
                    else:
                        mcp_bridge.send(msg)
                    continue

                # --- Route tool_response based on registration state ---
                if msg_type == "tool_response":
                    if anvil_registered:
                        # Large payloads (screenshots) should still use temp file
                        # spill-through — the extension already handles this,
                        # but guard against oversized forward to MCP stdin
                        try:
                            payload_size = len(orjson.dumps(msg))
                        except Exception:
                            payload_size = 0
                        if payload_size > LARGE_PAYLOAD_THRESHOLD:
                            sys.stderr.write(
                                f"MCP: large tool_response ({payload_size} bytes) "
                                f"— forwarding via temp file\n"
                            )
                            # Spill to temp file, send pointer
                            req_id = msg.get("requestId", "unknown")
                            if not _SAFE_ID_RE.match(str(req_id)):
                                req_id = secrets.token_hex(8)
                            os.makedirs(TEMP_DIR, mode=0o700, exist_ok=True)
                            filepath = os.path.join(
                                TEMP_DIR, f"mcp_result_{req_id}.json"
                            )
                            try:
                                with open(filepath, "wb") as f:
                                    f.write(orjson.dumps(msg))
                                # Write JSON-RPC notification with file pointer
                                mcp_bridge.send({
                                    "jsonrpc": "2.0",
                                    "method": "anvil/tool_response",
                                    "params": {
                                        "id": req_id,
                                        "success": msg.get("success", False),
                                        "result": {"tempFile": filepath},
                                        "error": msg.get("error"),
                                    },
                                })
                            except Exception as e:
                                sys.stderr.write(
                                    f"MCP: temp file write failed: {e}\n"
                                )
                        else:
                            # Translate tool_response to JSON-RPC notification
                            # that server.js understands
                            translated = {
                                "jsonrpc": "2.0",
                                "method": "anvil/tool_response",
                                "params": {
                                    "id": msg.get("requestId"),
                                    "success": msg.get("success", False),
                                    "result": msg.get("result"),
                                    "error": msg.get("error"),
                                },
                            }
                            mcp_bridge.send(translated)
                    else:
                        chrome_to_pty(master_fd, msg)
                    continue

                # --- PTY input goes direct to master_fd ---
                if msg_type == "pty_input":
                    data = msg.get("data", "")
                    if isinstance(data, str) and data:
                        try:
                            os.write(master_fd, data.encode("utf-8"))
                        except OSError:
                            pass
                    continue

                # --- Everything else goes to PTY bridge ---
                chrome_to_pty(master_fd, msg)

            except orjson.JSONDecodeError as e:
                sys.stderr.write(f"MSG: JSON decode error in chrome_reader: {e}\n")
                continue
            except OSError as e:
                sys.stderr.write(f"MSG: OS error in chrome_reader: {e}\n")
                break
            except Exception as e:
                sys.stderr.write(f"MSG: unexpected error in chrome_reader: {e}\n")
                break
        shutdown_event.set()

    chrome_thread = threading.Thread(target=chrome_reader, daemon=True)
    chrome_thread.start()

    try:
        while not shutdown_event.is_set():
            if child.poll() is not None:
                send_message(
                    {
                        "type": "pty_exited",
                        "exitCode": child.returncode,
                    }
                )
                break
            time.sleep(0.5)
    except Exception:
        pass
    finally:
        shutdown_event.set()
        mcp_bridge.shutdown()

        # Close stdin to unblock chrome_reader from its blocking read()
        try:
            sys.stdin.buffer.close()
        except Exception:
            pass

        reader_thread.join(timeout=2)
        chrome_thread.join(timeout=2)

        try:
            os.close(master_fd)
        except OSError:
            pass

        # Flush stdout before cleanup so Chrome gets final messages
        try:
            sys.stdout.buffer.flush()
        except Exception:
            pass

        cleanup(child.pid)

        # os._exit skips _Py_Finalize which races with daemon threads on buffered IO
        os._exit(0)


if __name__ == "__main__":
    main()
