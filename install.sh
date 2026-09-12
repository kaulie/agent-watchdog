#!/usr/bin/env bash
# Install + (re)start the independent watchdog service.
#
#   git clone https://github.com/kaulie/agent-watchdog
#   cd agent-watchdog
#   ./install.sh
#   # → ~/runtime/agent-watchdog, HTTP :4230, 随开机/登录自动启动
#
# 自启动默认开启（launchd LaunchAgent / systemd --user unit）：
#   WATCHDOG_AUTOSTART=0            # 只安装，不注册自启动（传统 nohup 模式）
#   WATCHDOG_AUTOSTART_JITTER_SEC=0 # 关闭启动随机延迟
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"
AUTOSTART="${WATCHDOG_AUTOSTART:-1}"

echo "[install] → ${HOME_DIR}"
mkdir -p "${HOME_DIR}" "${HOME_DIR}/data" "${HOME_DIR}/logs"

rsync -a \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='outputs/' \
  --exclude='data/' \
  --exclude='logs/' \
  --exclude='test/' \
  --exclude='watchdog.pid' \
  --exclude='src-tree/' \
  --exclude='*.log' \
  --exclude='*.pid' \
  "${ROOT}/" "${HOME_DIR}/"

chmod +x "${HOME_DIR}/scripts/"*.sh "${HOME_DIR}/install.sh" "${HOME_DIR}/build.sh" 2>/dev/null || true

echo "[install] npm install + build..."
(
  cd "${HOME_DIR}"
  npm install --no-audit --no-fund
  npm run build
)

VERSION="$(node -p "require('${HOME_DIR}/package.json').version" 2>/dev/null || echo dev)"
printf '%s\n' "${VERSION}" >"${HOME_DIR}/VERSION"
echo "[install] version ${VERSION}"

if [ "${AUTOSTART}" = "0" ]; then
  echo "[install] autostart disabled (WATCHDOG_AUTOSTART=0) → nohup mode"
  WATCHDOG_HOME="${HOME_DIR}" "${HOME_DIR}/scripts/restart.sh"
else
  echo "[install] registering OS autostart (launchd / systemd --user)..."
  WATCHDOG_HOME="${HOME_DIR}" "${HOME_DIR}/scripts/install-autostart.sh"
fi

echo "[install] done — API http://127.0.0.1:${WATCHDOG_PORT:-4230}/health"
"${HOME_DIR}/scripts/autostart-status.sh" 2>/dev/null || true

