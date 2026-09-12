#!/usr/bin/env bash
# Restart the independent watchdog service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[restart] stopping..."
WATCHDOG_HOME="${WATCHDOG_HOME:-}" "${SCRIPT_DIR}/stop.sh"
sleep 1
echo "[restart] starting..."
WATCHDOG_HOME="${WATCHDOG_HOME:-}" "${SCRIPT_DIR}/start.sh"
echo "[restart] done"
