#!/usr/bin/env bash
# 停止 watchdog 服务。
#
# 若服务由 OS 管理器（launchd / systemd --user）持有，则必须通过管理器停止——
# 直接 kill 会被 KeepAlive / Restart=always 立刻拉起。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib-autostart.sh
source "${SCRIPT_DIR}/lib-autostart.sh"

HOME_DIR="${WD_HOME_DIR}"
PID_FILE="${HOME_DIR}/watchdog.pid"

if wd_autostart_loaded; then
  echo "[stop] 进程由 OS 管理器持有 → 通过管理器停止（$(wd_autostart_unit_path)）"
  wd_autostart_stop
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin)
      echo "[stop] 注意：unit 仍注册在 launchd，重新登录会再次自动启动；"
      echo "[stop]       永久关闭请用 scripts/uninstall-autostart.sh"
      ;;
    linux)
      echo "[stop] 注意：systemd 上仍是 enabled，重新登录/重新启动请用 scripts/start.sh"
      ;;
  esac
fi

stopped=0

if [ -f "${PID_FILE}" ]; then
  old="$(cat "${PID_FILE}" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "${old}" ] && kill -0 "${old}" 2>/dev/null; then
    kill "${old}" 2>/dev/null || true
    sleep 0.5
    kill -0 "${old}" 2>/dev/null && kill -9 "${old}" 2>/dev/null || true
    echo "[stop] stopped pid=${old}"
    stopped=1
  fi
  rm -f "${PID_FILE}"
fi

port_pids="$(lsof -ti:"${WD_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${port_pids}" ]; then
  # shellcheck disable=SC2086
  kill ${port_pids} 2>/dev/null || true
  echo "[stop] cleaned port ${WD_PORT} pids=${port_pids}"
  stopped=1
fi

if [ "${stopped}" = "1" ]; then
  echo "[stop] done"
else
  echo "[stop] not running"
fi
