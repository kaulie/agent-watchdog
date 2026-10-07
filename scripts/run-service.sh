#!/usr/bin/env bash
# Foreground entry for LaunchAgent / launchd KeepAlive.
#
# launchd tracks the PID of ProgramArguments. This script must stay in the
# foreground (exec node). Do not call start.sh / restart.sh from here — those
# background the process and exit, which makes KeepAlive respawn in a loop.
set -euo pipefail

HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"
PORT="${SERVICE_PORT:-${WATCHDOG_PORT:-4230}}"
HOST="${WATCHDOG_HOST:-127.0.0.1}"

mkdir -p "${HOME_DIR}/logs" "${HOME_DIR}/data"

if [ ! -f "${HOME_DIR}/dist/index.js" ]; then
  echo "[run-service][错误] missing ${HOME_DIR}/dist/index.js — run install.sh or build.sh first" >&2
  exit 1
fi

if [ -n "$(lsof -ti:"${PORT}" 2>/dev/null || true)" ]; then
  echo "[run-service][错误] port ${PORT} already in use" >&2
  exit 1
fi

APP_VERSION="${WATCHDOG_VERSION:-}"
if [ -z "${APP_VERSION}" ] && [ -f "${HOME_DIR}/VERSION" ]; then
  APP_VERSION="$(tr -d '[:space:]' < "${HOME_DIR}/VERSION")"
fi

cd "${HOME_DIR}"
export WATCHDOG_HOME="${HOME_DIR}"
export SERVICE_PORT="${PORT}"
export WATCHDOG_PORT="${PORT}"
export WATCHDOG_HOST="${HOST}"
[ -n "${APP_VERSION}" ] && export WATCHDOG_VERSION="${APP_VERSION}"

exec node dist/index.js
