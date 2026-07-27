#!/bin/bash

# Harness Launcher Startup Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=${PORT:-11000}
HOST=${HOST:-127.0.0.1}
NODE_ENV=${NODE_ENV:-production}

echo "📦 Harness Launcher"
echo "=================="
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
    npm ci
else
    echo "✓ Dependencies already installed"
fi

echo ""
echo "🚀 Starting Harness Launcher..."
echo "   URL: http://localhost:$PORT"
echo "   Ctrl+C to stop"
echo ""

cd "$SCRIPT_DIR"
PORT=$PORT HOST=$HOST NODE_ENV=$NODE_ENV node src/server.js
