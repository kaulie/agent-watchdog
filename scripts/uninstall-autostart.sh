#!/usr/bin/env bash
# 取消 watchdog 的 OS 级自启动：停止服务 + 移除 unit（并在 launchd 里持久禁用）。
# 幂等：未安装时是 no-op。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib-autostart.sh
source "${SCRIPT_DIR}/lib-autostart.sh"

log() { echo "[autostart] $*"; }

wd_platform_supported || {
  echo "[autostart][错误] 不支持的系统 $(uname -s)" >&2
  exit 1
}

UNIT_PATH="$(wd_autostart_unit_path)"
LABEL="$(wd_autostart_label)"

wd_autostart_stop

case "${WD_AUTOSTART_PLATFORM}" in
  darwin)
    launchctl disable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
    rm -f "${UNIT_PATH}"
    log "已移除 ${UNIT_PATH}（launchd 已 disable，重启/重新登录不会自动加载）"
    ;;
  linux)
    systemctl --user disable "$(wd_autostart_unit_name)" >/dev/null 2>&1 || true
    rm -f "${UNIT_PATH}"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    log "已移除 ${UNIT_PATH}（systemd --user 已 disable）"
    ;;
esac

log "服务已停止。如需重新自启动：scripts/install-autostart.sh"
log "如需临时前台/后台运行（不受 OS 管理器托管）：scripts/start.sh"
