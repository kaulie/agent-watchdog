#!/usr/bin/env bash
# 自启动状态一览：谁在持有进程、unit 在哪、服务是否健康。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib-autostart.sh
source "${SCRIPT_DIR}/lib-autostart.sh"

echo "== autostart =="
echo "platform   : $(uname -s) → ${WD_AUTOSTART_PLATFORM}"
if ! wd_platform_supported; then
  echo "installed  : no（本脚本仅支持 darwin / linux）"
  exit 0
fi
if [ ! -f "${WD_AUTOSTART_CLI}" ]; then
  echo "installed  : unknown（缺少 ${WD_AUTOSTART_CLI}，先 npm run build）"
  exit 0
fi

echo "home       : ${WD_HOME_DIR}"
echo "unit       : $(wd_autostart_unit_path)"
if wd_autostart_installed; then
  echo "installed  : yes（随开机/登录自动启动）"
else
  echo "installed  : no（安装：scripts/install-autostart.sh）"
fi

if wd_autostart_loaded; then
  echo "managed    : yes（OS 管理器持有进程）"
else
  echo "managed    : no"
fi

case "${WD_AUTOSTART_PLATFORM}" in
  darwin)
    launchctl print "gui/$(id -u)/$(wd_autostart_label)" 2>/dev/null |
      grep -E '^\s+(state|pid|program|last exit code) ' | sed 's/^/  /' || true
    ;;
  linux)
    echo "  enabled  : $(systemctl --user is-enabled "$(wd_autostart_unit_name)" 2>/dev/null || echo unknown)"
    echo "  active   : $(systemctl --user is-active "$(wd_autostart_unit_name)" 2>/dev/null || echo unknown)"
    ;;
esac

echo
echo "== health =="
if wd_healthy; then
  curl -fsS -m 3 "${WD_HEALTH_URL}"
  echo
else
  echo "unreachable: ${WD_HEALTH_URL}"
fi

if [ -f "${WD_HOME_DIR}/watchdog.pid" ]; then
  echo "pid file   : $(cat "${WD_HOME_DIR}/watchdog.pid" 2>/dev/null | tr -d '[:space:]')"
fi
