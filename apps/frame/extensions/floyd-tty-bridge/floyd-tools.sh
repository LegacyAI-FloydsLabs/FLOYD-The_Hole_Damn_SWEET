#!/usr/bin/env bash
# floyd-tools.sh — Agent SDK for Floyd's Labs TTY Bridge v5.1.0
#
# Works in TWO modes:
#   1. BRIDGE MODE  — inside Floyd TTY side panel (OSC 7701/7702 escape sequences)
#   2. PROXY MODE   — any external terminal (file-based IPC via ~/floyd_comm/)
#
# Usage:
#   source floyd-tools.sh
#   floyd_analyze_page
#   floyd_click ".btn-submit"
#   floyd_fill_form '{"#name":"John","#email":"john@example.com"}'

# ─── Mode Detection ──────────────────────────────────────────────────────────

FLOYD_COMM_DIR="${FLOYD_COMM_DIR:-$HOME/floyd_comm}"
_FLOYD_MODE="proxy"

if [[ -n "$FLOYD_TTY_BRIDGE" ]] || [[ "$FLOYD_TOOLS_AVAILABLE" == "1" ]]; then
  _FLOYD_MODE="bridge"
fi

# ─── Bridge Mode: OSC 7701/7702 ──────────────────────────────────────────────

_floyd_request_id=0

_floyd_wait_for_response() {
  local response=""
  local char=""
  local in_osc=0
  local osc_body=""

  while true; do
    if [ -n "$ZSH_VERSION" ]; then
      if ! read -r -k 1 -t 30 char; then break; fi
    else
      if ! IFS= read -r -n 1 -t 30 char; then break; fi
    fi

    if [[ $in_osc -eq 1 ]]; then
      if [[ "$char" == $'\007' ]]; then
        if [[ "$osc_body" == 7702\;* ]]; then
          response="${osc_body#7702;}"
          break
        fi
        in_osc=0
        osc_body=""
      else
        osc_body="${osc_body}${char}"
      fi
    elif [[ "$char" == $'\033' ]]; then
      if [ -n "$ZSH_VERSION" ]; then
        read -r -k 1 -t 5 char
      else
        IFS= read -r -n 1 -t 5 char
      fi
      if [[ "$char" == "]" ]]; then
        in_osc=1
        osc_body=""
      fi
    fi
  done

  if [[ -z "$response" ]]; then
    echo '{"ok":false,"error":"timeout"}'
    return 1
  fi

  if echo "$response" | grep -q '"file":'; then
    local filepath
    filepath=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file',''))" 2>/dev/null)
    if [[ -n "$filepath" && -f "$filepath" ]]; then
      cat "$filepath"
      return 0
    fi
  fi

  echo "$response"
}

_floyd_bridge_call() {
  local tool="$1"
  local args="$2"
  [[ -z "$args" ]] && args='{}'
  _floyd_request_id=$((_floyd_request_id + 1))
  local id="sh_${_floyd_request_id}_$$"

  printf '\033]7701;{"id":"%s","tool":"%s","args":%s}\007' "$id" "$tool" "$args"

  _floyd_wait_for_response
}

# ─── Proxy Mode: File-based IPC via ~/floyd_comm/ ────────────────────────────

_floyd_proxy_call() {
  local tool="$1"
  local args="$2"
  [[ -z "$args" ]] && args='{}'
  _floyd_request_id=$((_floyd_request_id + 1))
  local id="ext_${_floyd_request_id}_$$"
  local cmd_file="$FLOYD_COMM_DIR/cmd.json"
  local resp_file="$FLOYD_COMM_DIR/resp.json"
  local resp_id=""
  local elapsed=0

  mkdir -p "$FLOYD_COMM_DIR"

  # Clear stale response before writing new command
  rm -f "$resp_file"

  # Atomic write: tmp file then mv to avoid partial reads
  local tmp_file="$FLOYD_COMM_DIR/.cmd_tmp_$$"
  printf '{"id":"%s","tool":"%s","args":%s,"pending":true}' "$id" "$tool" "$args" > "$tmp_file"
  mv -f "$tmp_file" "$cmd_file"

  # Poll for matching response (1s intervals, 30s timeout)
  while [ $elapsed -lt 30000 ]; do
    if [ -f "$resp_file" ]; then
      resp_id="$(python3 -c "import json; print(json.load(open('${resp_file}')).get('id',''))" 2>/dev/null)" || resp_id=""
      if [ "$resp_id" = "$id" ]; then
        cat "$resp_file"
        rm -f "$resp_file"
        return 0
      fi
    fi
    sleep 1
    elapsed=$((elapsed + 1000))
  done

  echo '{"ok":false,"error":"proxy timeout — is Floyd side panel open?"}'
  return 1
}

# ─── Unified floyd_call dispatcher ───────────────────────────────────────────

floyd_call() {
  local tool="$1"
  local args="$2"
  [[ -z "$args" ]] && args='{}'

  if [[ "$_FLOYD_MODE" == "bridge" ]]; then
    _floyd_bridge_call "$tool" "$args"
  else
    _floyd_proxy_call "$tool" "$args"
  fi
}

floyd_ask_tom() {
  local query="$1"
  if [[ "$_FLOYD_MODE" == "bridge" ]]; then
    _floyd_request_id=$((_floyd_request_id + 1))
    local id="sh_${_floyd_request_id}_$$"
    local escaped_query
    escaped_query=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$query")
    printf '\033]7701;{"type":"ragbot_request","id":"%s","query":%s}\007' "$id" "$escaped_query"
    _floyd_wait_for_response
  else
    # Proxy mode: send as a tool call that the panel can handle
    floyd_call ask_tom "{\"query\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$query")}"
  fi
}

# ─── Convenience Functions ────────────────────────────────────────────────────

floyd_analyze_page() {
  floyd_call analyze_page '{"include_css":true,"include_accessibility":true}'
}

floyd_dom() {
  floyd_call analyze_page '{"include_css":false,"include_accessibility":false}'
}

floyd_a11y() {
  local level="${1:-AA}"
  floyd_call check_accessibility "{\"level\":\"$level\"}"
}

floyd_click() {
  local selector="$1"
  floyd_call click_element "{\"selector\":\"$selector\"}"
}

floyd_type() {
  local selector="$1"
  local text="$2"
  floyd_call type_text "{\"selector\":\"$selector\",\"text\":\"$text\"}"
}

floyd_navigate() {
  local url="$1"
  floyd_call navigate_to "{\"url\":\"$url\"}"
}

floyd_screenshot() {
  floyd_call take_screenshot '{}'
}

floyd_find() {
  local query="$1"
  floyd_call find_elements "{\"query\":\"$query\"}"
}

floyd_extract_text() {
  local selector="${1:-body}"
  floyd_call extract_text "{\"selector\":\"$selector\"}"
}

floyd_extract_css() {
  local selector="$1"
  floyd_call extract_css "{\"selector\":\"$selector\"}"
}

floyd_contrast() {
  local selector="${1:-body}"
  floyd_call check_contrast "{\"selector\":\"$selector\"}"
}

floyd_fill_form() {
  local fields="$1"
  floyd_call fill_form "{\"fields\":$fields}"
}

floyd_select() {
  local selector="$1"
  local value="$2"
  floyd_call select_option "{\"selector\":\"$selector\",\"value\":\"$value\"}"
}

floyd_scroll() {
  local target="${1:-bottom}"
  floyd_call scroll_to "{\"target\":\"$target\"}"
}

floyd_wait() {
  local selector="$1"
  local timeout="${2:-5000}"
  floyd_call wait_for_element "{\"selector\":\"$selector\",\"timeout\":$timeout}"
}

floyd_tabs() {
  floyd_call list_tabs '{}'
}

floyd_open_tab() {
  local url="$1"
  floyd_call open_tab "{\"url\":\"$url\"}"
}

floyd_close_tab() {
  local tab_id="$1"
  floyd_call close_tab "{\"tab_id\":$tab_id}"
}

floyd_switch_tab() {
  local tab_id="$1"
  floyd_call switch_tab "{\"tab_id\":$tab_id}"
}

floyd_page_state() {
  floyd_call get_page_state '{}'
}

floyd_element() {
  local selector="$1"
  floyd_call analyze_element "{\"selector\":\"$selector\"}"
}

floyd_refresh() {
  if [[ "$_FLOYD_MODE" == "bridge" ]]; then
    printf '\033]7701;{"type":"browser_refresh"}\007'
  else
    floyd_call navigate_to '{"url":"__reload__"}'
  fi
}

# ─── Knowledge Base Query ─────────────────────────────────────────────────────

floyd_query() {
  local query="$1"
  local collection="${2:-}"
  local top_k="${3:-5}"

  local args="{\"query\":\"$query\",\"top_k\":$top_k"
  if [[ -n "$collection" ]]; then
    args="${args},\"collection\":\"$collection\""
  fi
  args="${args}}"

  floyd_call query_knowledge "$args"
}

floyd_verify_claim() {
  local id="$1"
  local text="$2"
  local source="$3"
  local ref="$4"
  local status="$5"
  local notes="$6"
  floyd_call write_observation "{\"type\":\"verification_report\",\"claim_id\":\"$id\",\"claim_text\":\"$text\",\"source_doc\":\"$source\",\"code_reference\":\"$ref\",\"status\":\"$status\",\"notes\":\"$notes\"}"
}

floyd_ui_audit() {
  floyd_call audit_ui '{}'
}

floyd_reload() {
  floyd_call reload_extension '{}'
}

# ─── Status ───────────────────────────────────────────────────────────────────

floyd_status() {
  echo "Floyd's Labs TTY Bridge v5.1.0 — Agent SDK"
  echo "  Mode:   ${_FLOYD_MODE}"
  echo "  Bridge: ${FLOYD_TTY_BRIDGE:-not detected}"
  echo "  Proxy:  ${FLOYD_COMM_DIR}"
  echo "  Shell:  $SHELL (PID $$)"
  echo ""
  echo "Available commands:"
  echo "  floyd_call <tool> [json_args]  — Raw tool call"
  echo "  floyd_analyze_page             — Full page analysis"
  echo "  floyd_dom                      — DOM structure"
  echo "  floyd_a11y [AA|AAA]            — Accessibility audit"
  echo "  floyd_click <selector>         — Click element"
  echo "  floyd_type <selector> <text>   — Type into element"
  echo "  floyd_navigate <url>           — Navigate to URL"
  echo "  floyd_screenshot               — Capture visible tab"
  echo "  floyd_find <query>             — Find elements by text"
  echo "  floyd_extract_text [selector]  — Extract text content"
  echo "  floyd_extract_css <selector>   — Get computed CSS"
  echo "  floyd_contrast [selector]      — Check contrast ratios"
  echo "  floyd_fill_form '{fields}'     — Fill multiple form fields"
  echo "  floyd_select <sel> <value>     — Select dropdown option"
  echo "  floyd_scroll [target]          — Scroll to position"
  echo "  floyd_wait <selector> [ms]     — Wait for element"
  echo "  floyd_tabs                     — List open tabs"
  echo "  floyd_open_tab <url>           — Open new tab"
  echo "  floyd_close_tab <id>           — Close tab"
  echo "  floyd_switch_tab <id>          — Switch to tab"
  echo "  floyd_page_state               — Current page state"
  echo "  floyd_element <selector>       — Deep element analysis"
  echo "  floyd_refresh                  — Reload the active browser tab"
  echo "  floyd_reload                   — Reload the Floyd extension"
  echo "  floyd_ask_tom <text>           — Ask Tom what he sees"
  echo "  floyd_query <text> [coll] [k]  — Query knowledge base"
  echo "  floyd_verify_claim <id> <t>... — Record verification result"
  echo "  floyd_status                   — This help"
}

# ─── Announce ─────────────────────────────────────────────────────────────────

if [[ "$_FLOYD_MODE" == "bridge" ]]; then
  echo "[floyd-tools] Bridge mode — OSC 7701/7702 active. Run floyd_status for help."
else
  mkdir -p "$FLOYD_COMM_DIR"
  echo "[floyd-tools] Proxy mode — communicating via ${FLOYD_COMM_DIR}/"
  echo "[floyd-tools] Make sure the Floyd side panel is open in Chrome."
fi
