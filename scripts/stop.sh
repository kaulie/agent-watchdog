#!/usr/bin/env bash
# Stop the independent watchdog service.
set -euo pipefail

HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"
PID_FILE="${HOME_DIR}/watchdog.pid"
PORT="${WATCHDOG_PORT:-${PORT:-4230}}"

stopped=0

if [ -f "${PID_FILE}" ]; then
  old="$(tr -d '[:space:]' < "${PID_FILE}" || true)"
  if [ -n "${old}" ] && kill -0 "${old}" 2>/dev/null; then
    kill "${old}" 2>/dev/null || true
    sleep 0.5
    kill -0 "${old}" 2>/dev/null && kill -9 "${old}" 2>/dev/null || true
    echo "[stop] stopped pid=${old}"
    stopped=1
  fi
  rm -f "${PID_FILE}"
fi

port_pids="$(lsof -ti:"${PORT}" 2>/dev/null || true)"
if [ -n "${port_pids}" ]; then
  kill ${port_pids} 2>/dev/null || true
  echo "[stop] cleaned port ${PORT} pids=${port_pids}"
  stopped=1
fi

if [ "${stopped}" = "1" ]; then
  echo "[stop] done"
else
  echo "[stop] not running"
fi
