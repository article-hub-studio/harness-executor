#!/usr/bin/env bash
# start.sh — khởi động upio MCP Executor Harness (mobile executor)
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
echo "⚡ Khởi động upio MCP Executor Harness tại http://localhost:${PORT} ..."
exec node server/index.js
