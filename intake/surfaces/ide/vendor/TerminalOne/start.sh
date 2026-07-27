#!/bin/bash

# TerminalOne Startup Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=${PORT:-11001}

echo "📦 TerminalOne"
echo "============="
echo ""
echo "Checking dependencies..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

echo "✓ Node.js: $(node -v)"

# Check if npm dependencies are installed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo ""
    echo "📥 Installing dependencies..."
    cd "$SCRIPT_DIR"
    npm install
else
    echo "✓ Dependencies already installed"
fi

echo ""
echo "🚀 Starting TerminalOne..."
echo "   URL: http://localhost:$PORT"
echo "   Ctrl+C to stop"
echo ""

cd "$SCRIPT_DIR"
PORT=$PORT node src/server.js
