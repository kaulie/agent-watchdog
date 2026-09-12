#!/usr/bin/env bash
# Show the watchdog's own health plus the status of every monitored service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${WATCHDOG_PORT:-4230}"
HOST="${WATCHDOG_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

if ! curl -fsS -m 3 "${BASE}/health" >/dev/null 2>&1; then
  echo "[status] watchdog NOT reachable at ${BASE}/health"
  echo "[status] autostart state:"
  "${SCRIPT_DIR}/autostart-status.sh" || true
  exit 1
fi

echo "== watchdog =="
curl -fsS -m 3 "${BASE}/health"
echo
echo "== stats =="
curl -fsS -m 3 "${BASE}/api/stats"
echo
echo "== pause =="
curl -fsS -m 3 "${BASE}/api/pause"
echo
echo "== services =="
curl -fsS -m 5 "${BASE}/api/services"
echo
echo
"${SCRIPT_DIR}/autostart-status.sh" || true
