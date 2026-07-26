#!/usr/bin/env bash
# =============================================================================
# Floyd's Labs TTY Bridge -- Native Messaging Host Installer v4.0
#
# Installs the native messaging host for Chrome, Chromium, and Brave on macOS.
# Safe to run multiple times (idempotent).
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}$*${RESET}\n"; }

HOST_NAME="com.floyd.tty"
INSTALL_PATH="/usr/local/bin/floyd_tty_host.py"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT="${SCRIPT_DIR}/native_host.py"

# Browser manifest directories on macOS
declare -A BROWSER_PATHS
BROWSER_PATHS=(
    ["Chrome"]="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ["Chromium"]="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    ["Brave"]="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
header "Floyd's Labs TTY Bridge -- Installer v4.0"

# Check platform
if [[ "$(uname)" != "Darwin" ]]; then
    error "This installer is for macOS only."
    exit 1
fi

# Check Python 3
if ! command -v python3 &>/dev/null; then
    error "Python 3 is required but not found. Install it from https://www.python.org/"
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
info "Found Python ${PYTHON_VERSION}"

# Check source script exists
if [[ ! -f "$SOURCE_SCRIPT" ]]; then
    error "Cannot find native_host.py at: ${SOURCE_SCRIPT}"
    error "Run this script from the extension directory."
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Install the host script
# ---------------------------------------------------------------------------
header "Step 1: Installing native host script"

info "Copying native_host.py -> ${INSTALL_PATH}"
if [[ -f "$INSTALL_PATH" ]]; then
    warn "Existing installation found -- overwriting."
fi

sudo cp "$SOURCE_SCRIPT" "$INSTALL_PATH"
sudo chmod 755 "$INSTALL_PATH"

# Ensure the shebang points to python3
FIRST_LINE=$(head -1 "$INSTALL_PATH")
if [[ "$FIRST_LINE" != "#!/usr/bin/env python3" ]]; then
    warn "Fixing shebang line."
    sudo sed -i '' '1s|.*|#!/usr/bin/env python3|' "$INSTALL_PATH"
fi

success "Native host script installed at ${INSTALL_PATH}"

# ---------------------------------------------------------------------------
# Step 2: Determine extension ID
# ---------------------------------------------------------------------------
header "Step 2: Detecting Chrome extension ID"

EXTENSION_ID=""

# Try to detect from manifest.json in the same directory
MANIFEST_FILE="${SCRIPT_DIR}/manifest.json"
if [[ -f "$MANIFEST_FILE" ]]; then
    info "Found manifest.json -- checking for key-based ID..."
    # If there's a "key" field we can note it, but the actual installed ID
    # depends on Chrome. We'll still need the user to confirm.
fi

# Try to find installed extension directories
CHROME_EXT_DIR="$HOME/Library/Application Support/Google/Chrome/Default/Extensions"
if [[ -d "$CHROME_EXT_DIR" ]]; then
    info "Scanning installed Chrome extensions..."
    while IFS= read -r ext_dir; do
        ext_id=$(basename "$ext_dir")
        # Look for our manifest inside any version subfolder
        for ver_dir in "$ext_dir"/*/; do
            if [[ -f "${ver_dir}manifest.json" ]]; then
                if grep -q "Floyd.*TTY\|floyd.*tty\|Floyd's Labs" "${ver_dir}manifest.json" 2>/dev/null; then
                    EXTENSION_ID="$ext_id"
                    info "Detected extension ID: ${EXTENSION_ID}"
                    break 2
                fi
            fi
        done
    done < <(find "$CHROME_EXT_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
fi

# If not auto-detected, ask the user
if [[ -z "$EXTENSION_ID" ]]; then
    warn "Could not auto-detect extension ID."
    echo ""
    echo -e "  To find your extension ID:"
    echo -e "    1. Open ${BOLD}chrome://extensions${RESET} in Chrome"
    echo -e "    2. Enable ${BOLD}Developer mode${RESET} (top right)"
    echo -e "    3. Find ${BOLD}Floyd TTY Bridge${RESET} and copy the ID"
    echo ""
    read -rp "  Enter extension ID: " EXTENSION_ID

    if [[ -z "$EXTENSION_ID" ]]; then
        error "No extension ID provided. Cannot continue."
        exit 1
    fi
fi

# Validate format (32 lowercase hex-like characters)
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    warn "Extension ID '${EXTENSION_ID}' doesn't match expected format (32 lowercase a-p chars)."
    read -rp "  Continue anyway? [y/N] " confirm
    if [[ "${confirm,,}" != "y" ]]; then
        error "Aborted."
        exit 1
    fi
fi

success "Using extension ID: ${EXTENSION_ID}"

# ---------------------------------------------------------------------------
# Step 3: Generate and install the native messaging manifest
# ---------------------------------------------------------------------------
header "Step 3: Installing native messaging manifests"

MANIFEST_JSON=$(cat <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Floyd's Labs TTY Bridge Native Host v4.0",
  "path": "${INSTALL_PATH}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXTENSION_ID}/"]
}
EOF
)

INSTALLED_COUNT=0

for browser in "Chrome" "Chromium" "Brave"; do
    target_dir="${BROWSER_PATHS[$browser]}"

    # Only install if the browser appears to be installed
    # (check if the parent Application Support dir for this browser exists)
    browser_app_dir="$(dirname "$target_dir")"
    if [[ ! -d "$browser_app_dir" ]]; then
        continue
    fi

    info "Installing manifest for ${browser}..."

    # Create the NativeMessagingHosts directory if it doesn't exist
    mkdir -p "$target_dir"

    manifest_path="${target_dir}/${HOST_NAME}.json"

    if [[ -f "$manifest_path" ]]; then
        warn "Overwriting existing manifest at ${manifest_path}"
    fi

    echo "$MANIFEST_JSON" > "$manifest_path"
    chmod 644 "$manifest_path"
    success "Manifest installed: ${manifest_path}"
    INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
done

if [[ "$INSTALLED_COUNT" -eq 0 ]]; then
    error "No supported browsers found. Manually create the manifest directory."
    echo ""
    echo "  For Chrome:"
    echo "    mkdir -p \"${BROWSER_PATHS[Chrome]}\""
    echo "    Then re-run this script."
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: Install agent SDK
# ---------------------------------------------------------------------------
header "Step 4: Installing agent SDK"

SDK_SOURCE="${SCRIPT_DIR}/floyd-tools.sh"
SDK_INSTALL="/usr/local/share/floyd/floyd-tools.sh"

if [[ -f "$SDK_SOURCE" ]]; then
    sudo mkdir -p /usr/local/share/floyd
    sudo cp "$SDK_SOURCE" "$SDK_INSTALL"
    sudo chmod 644 "$SDK_INSTALL"
    success "Agent SDK installed at ${SDK_INSTALL}"
    info "Agents can source it with: source ${SDK_INSTALL}"
else
    warn "floyd-tools.sh not found in extension directory — skipping SDK install."
fi

# ---------------------------------------------------------------------------
# Step 5: Create /tmp/floyd directory
# ---------------------------------------------------------------------------
header "Step 5: Preparing runtime directories"

mkdir -p /tmp/floyd
chmod 755 /tmp/floyd
success "Runtime directory /tmp/floyd is ready."

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
header "Installation complete!"

echo -e "  Native host:  ${BOLD}${INSTALL_PATH}${RESET}"
echo -e "  Extension ID: ${BOLD}${EXTENSION_ID}${RESET}"
echo -e "  Manifests:    ${BOLD}${INSTALLED_COUNT} browser(s)${RESET}"
echo ""
echo -e "  ${CYAN}Verify installation:${RESET}"
echo ""
echo -e "    # Check the manifest is valid JSON"
echo -e "    python3 -m json.tool ~/Library/Application\\ Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
echo ""
echo -e "    # Test the native host starts correctly"
echo -e "    echo '{\"type\":\"ping\"}' | python3 ${INSTALL_PATH} 2>/dev/null || true"
echo ""
echo -e "  ${CYAN}If you update the extension (new ID), re-run this script.${RESET}"
echo ""
