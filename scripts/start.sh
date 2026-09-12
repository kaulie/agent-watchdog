#!/usr/bin/env bash
# Start the independent watchdog service (no build here; use install.sh / build.sh).
set -euo pipefail

HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"
PID_FILE="${HOME_DIR}/watchdog.pid"
LOG_FILE="${HOME_DIR}/logs/watchdog.log"
PORT="${WATCHDOG_PORT:-${PORT:-4230}}"
HOST="${WATCHDOG_HOST:-127.0.0.1}"
HEALTH_URL="http://${HOST}:${PORT}/health"

mkdir -p "${HOME_DIR}/logs" "${HOME_DIR}/data"

if [ -f "${PID_FILE}" ]; then
  old="$(tr -d '[:space:]' < "${PID_FILE}" || true)"
  if [ -n "${old}" ] && kill -0 "${old}" 2>/dev/null; then
    echo "[start] already running pid=${old}"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

if [ -n "$(lsof -ti:"${PORT}" 2>/dev/null || true)" ]; then
  echo "[start] port ${PORT} already in use — assuming running"
  exit 0
fi

if [ ! -f "${HOME_DIR}/dist/index.js" ]; then
  echo "[start][错误] missing ${HOME_DIR}/dist/index.js — run install.sh or build.sh first" >&2
  exit 1
fi

APP_VERSION="${WATCHDOG_VERSION:-}"
if [ -z "${APP_VERSION}" ] && [ -f "${HOME_DIR}/VERSION" ]; then
  APP_VERSION="$(tr -d '[:space:]' < "${HOME_DIR}/VERSION")"
fi

cd "${HOME_DIR}"
export WATCHDOG_HOME="${HOME_DIR}"
export WATCHDOG_PORT="${PORT}"
export WATCHDOG_HOST="${HOST}"
[ -n "${APP_VERSION}" ] && export WATCHDOG_VERSION="${APP_VERSION}"

nohup node dist/index.js >>"${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" > "${PID_FILE}"

for _ in $(seq 1 40); do
  if curl -fsS -m 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[start] ok pid=${NEW_PID} ${HEALTH_URL}"
    exit 0
  fi
  if ! kill -0 "${NEW_PID}" 2>/dev/null; then
    echo "[start][错误] process exited early; log tail:" >&2
    tail -20 "${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    exit 1
  fi
  sleep 0.25
done

echo "[start][错误] health check timed out (${HEALTH_URL}); log tail:" >&2
tail -20 "${LOG_FILE}" >&2
exit 1
