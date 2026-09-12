#!/usr/bin/env bash
# 启动 watchdog 服务（构建请用 install.sh / build.sh）。
#
# 两种模式，优先级从高到低：
#   1. 已安装 OS 级自启动（launchd / systemd --user）→ 委派给 OS 管理器启动，
#      避免出现第二份不受监管的进程（自启动把「谁看门狗」交给 OS，见 README）。
#   2. 未注册自启动 → 传统的 nohup 后台模式（开发机 / 无 systemd 环境）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib-autostart.sh
source "${SCRIPT_DIR}/lib-autostart.sh"

HOME_DIR="${WD_HOME_DIR}"
PID_FILE="${HOME_DIR}/watchdog.pid"
LOG_FILE="${HOME_DIR}/logs/service.log"

mkdir -p "${HOME_DIR}/logs" "${HOME_DIR}/data"

if wd_healthy; then
  echo "[start] 已在运行 ${WD_HEALTH_URL}"
  exit 0
fi

if wd_autostart_installed; then
  echo "[start] 自启动已安装 → 由 OS 管理器启动（$(wd_autostart_unit_path)）"
  wd_autostart_start
  if wd_wait_health 60 0.5; then
    echo "[start] ok ${WD_HEALTH_URL}"
    exit 0
  fi
  echo "[start][错误] OS 管理器启动后仍未通过健康检查；最近日志：" >&2
  tail -20 "${LOG_FILE}" 2>/dev/null >&2 || true
  exit 1
fi

echo "[start] 未安装自启动 → nohup 模式"

if [ -f "${PID_FILE}" ]; then
  old="$(cat "${PID_FILE}" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "${old}" ] && kill -0 "${old}" 2>/dev/null; then
    echo "[start] 进程存在 pid=${old}（健康检查未通过）"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

if [ -n "$(lsof -ti:"${WD_PORT}" -sTCP:LISTEN 2>/dev/null || true)" ]; then
  echo "[start] 端口 ${WD_PORT} 已被占用 — 视为运行中"
  exit 0
fi

if [ ! -f "${HOME_DIR}/dist/index.js" ]; then
  echo "[start][错误] 缺少 ${HOME_DIR}/dist/index.js — 先运行 install.sh 或 build.sh" >&2
  exit 1
fi

nohup bash "${SCRIPT_DIR}/run-service.sh" >>"${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" >"${PID_FILE}"

if wd_wait_health 120 0.5; then
  echo "[start] ok pid=${NEW_PID} ${WD_HEALTH_URL}"
  exit 0
fi

if ! kill -0 "${NEW_PID}" 2>/dev/null; then
  echo "[start][错误] 进程提前退出；最近日志：" >&2
  tail -20 "${LOG_FILE}" >&2
  rm -f "${PID_FILE}"
  exit 1
fi

echo "[start][错误] 健康检查超时（${WD_HEALTH_URL}）；最近日志：" >&2
tail -20 "${LOG_FILE}" >&2
exit 1
