#!/usr/bin/env bash
# 重启 watchdog 服务。
# 已安装 OS 级自启动时，通过管理器重启（kickstart -k / systemctl restart），
# 避免 stop+start 期间 KeepAlive 把进程又拉起来造成竞态。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib-autostart.sh
source "${SCRIPT_DIR}/lib-autostart.sh"

if wd_autostart_installed && wd_autostart_loaded; then
  echo "[restart] 通过 OS 管理器重启（$(wd_autostart_unit_path)）"
  wd_autostart_restart
  if wd_wait_health 60 0.5; then
    echo "[restart] done — $(curl -fsS -m 3 "${WD_HEALTH_URL}")"
    exit 0
  fi
  echo "[restart][错误] 重启后未通过健康检查：${WD_HEALTH_URL}" >&2
  exit 1
fi

echo "[restart] stopping..."
WATCHDOG_HOME="${WATCHDOG_HOME:-}" "${SCRIPT_DIR}/stop.sh"
sleep 1
echo "[restart] starting..."
WATCHDOG_HOME="${WATCHDOG_HOME:-}" "${SCRIPT_DIR}/start.sh"
echo "[restart] done"

