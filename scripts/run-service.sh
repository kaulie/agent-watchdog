#!/usr/bin/env bash
# Foreground entrypoint executed by the OS service manager
# (launchd LaunchAgent / systemd --user unit). Never `nohup` this by hand —
# use scripts/start.sh, which knows whether autostart owns the process.
#
# Responsibilities (deliberately small):
#   1. cd into the install dir, refuse to start without a build.
#   2. optional randomized startup delay (WATCHDOG_START_JITTER_SEC) to avoid
#      boot-time thundering herd.
#   3. rotate the manager-side logs, then exec the HTTP service (PID preserved,
#      so the manager's restart semantics stay honest).
set -euo pipefail

HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"
LOG_DIR="${HOME_DIR}/logs"
LOG_MAX_BYTES="${WATCHDOG_LOG_MAX_BYTES:-10485760}" # 10 MiB
LOG_BACKUPS="${WATCHDOG_LOG_BACKUPS:-3}"

mkdir -p "${LOG_DIR}"
cd "${HOME_DIR}"

if [ ! -f "${HOME_DIR}/dist/index.js" ]; then
  echo "[run-service][错误] 缺少 ${HOME_DIR}/dist/index.js — 先运行 install.sh 或 npm run build" >&2
  exit 1
fi

rotate_log() {
  local file="$1"
  [ -f "${file}" ] || return 0
  local size
  size="$(wc -c <"${file}" 2>/dev/null || echo 0)"
  if [ "${size}" -gt "${LOG_MAX_BYTES}" ]; then
    rm -f "${file}.${LOG_BACKUPS}"
    local i=$((LOG_BACKUPS - 1))
    while [ "${i}" -ge 1 ]; do
      [ -f "${file}.${i}" ] && mv "${file}.${i}" "${file}.$((i + 1))"
      i=$((i - 1))
    done
    mv "${file}" "${file}.1"
  fi
}

rotate_log "${LOG_DIR}/service.log"
rotate_log "${LOG_DIR}/service.error.log"

JITTER="${WATCHDOG_START_JITTER_SEC:-0}"
if [ -n "${JITTER}" ] && [ "${JITTER}" != "0" ]; then
  delay="$(awk -v max="${JITTER}" 'BEGIN { srand(); printf "%.3f", rand() * max }')"
  echo "[run-service] $(date '+%F %T') 随机启动延迟 ${delay}s（上限 ${JITTER}s）"
  sleep "${delay}"
fi

export WATCHDOG_HOME="${HOME_DIR}"
echo "[run-service] $(date '+%F %T') exec node dist/index.js (${WATCHDOG_HOST:-127.0.0.1}:${WATCHDOG_PORT:-4230})"
exec node dist/index.js
