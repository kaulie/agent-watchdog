#!/usr/bin/env bash
# 把 watchdog 注册成 OS 级自启动服务：随机器/登录自动启动，进程死亡自动拉起。
#   macOS : ~/Library/LaunchAgents/<label>.plist   (launchd LaunchAgent)
#   Linux : ~/.config/systemd/user/<unit>          (systemd --user)
# 幂等：重复执行 = 重新渲染 unit 并重启服务。
#
# 注意：注册后由 OS 管理器持有进程生命周期；不要再 `nohup` 手动起第二份，
# 请用 scripts/start.sh / scripts/restart.sh（它们会自动委派给管理器）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JITTER="${WATCHDOG_AUTOSTART_JITTER_SEC:-3}"

# shellcheck source=lib-autostart.sh
source "${SCRIPT_DIR}/lib-autostart.sh"

log() { echo "[autostart] $*"; }

wd_platform_supported || {
  echo "[autostart][错误] 不支持的系统 $(uname -s)（仅 darwin / linux）" >&2
  exit 1
}
[ -f "${WD_HOME_DIR}/dist/index.js" ] || {
  echo "[autostart][错误] 缺少 ${WD_HOME_DIR}/dist/index.js — 先运行 ./install.sh" >&2
  exit 1
}
[ -f "${WD_AUTOSTART_CLI}" ] || {
  echo "[autostart][错误] 缺少 ${WD_AUTOSTART_CLI} — 先运行 npm run build" >&2
  exit 1
}

# 端口预检：万一 WATCHDOG_PORT 被配置成别的服务（例如 web-cursor 的 4211）的端口，
# 宁可拒绝注册，也不要起一个影子服务（历史上就是这样把端口继承错的）。
if [ -z "${WATCHDOG_PORT:-}" ] && [ -n "${PORT:-}" ]; then
  echo "[autostart] 注意：环境里的 PORT=${PORT} 被忽略（只认 WATCHDOG_PORT），使用 ${WD_PORT}"
fi
busy_pids="$(lsof -ti:"${WD_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
for pid in ${busy_pids}; do
  if wd_pid_is_ours "${pid}"; then
    echo "[autostart] 接管：停止当前占用 ${WD_PORT} 的旧实例 pid=${pid}"
    kill "${pid}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.25
    done
    kill -0 "${pid}" 2>/dev/null && kill -9 "${pid}" 2>/dev/null || true
  else
    echo "[autostart][错误] 端口 ${WD_PORT} 已被非本服务的进程占用：" >&2
    echo "[autostart]   pid=${pid} cwd=$(wd_pid_cwd "${pid}") cmd=$(wd_pid_cmd "${pid}")" >&2
    echo "[autostart]   如非本意，请检查 WATCHDOG_PORT（只会取自 WATCHDOG_PORT，不读 PORT）" >&2
    exit 1
  fi
done

UNIT_PATH="$(wd_autostart_unit_path)"
LABEL="$(wd_autostart_label)"
UNIT_DIR="$(mktemp -d -t agent-watchdog-unit)"

cleanup() { rm -rf "${UNIT_DIR}"; }
trap cleanup EXIT

UNIT_SUFFIX=""
if [ "${WD_AUTOSTART_PLATFORM}" = "darwin" ]; then UNIT_SUFFIX=".plist"; fi
UNIT_TMP="${UNIT_DIR}/unit${UNIT_SUFFIX}"
node "${WD_AUTOSTART_CLI}" render \
  --platform "${WD_AUTOSTART_PLATFORM}" \
  --home "${WD_HOME_DIR}" \
  --host "${WD_HOST}" \
  --port "${WD_PORT}" \
  --jitter-sec "${JITTER}" \
  --node "$(command -v node)" \
  --out "${UNIT_TMP}" >/dev/null

if [ "${WD_AUTOSTART_PLATFORM}" = "darwin" ]; then
  plutil -lint "${UNIT_TMP}" >/dev/null || {
    echo "[autostart][错误] 渲染出的 plist 校验失败：${UNIT_TMP}" >&2
    exit 1
  }
fi

mkdir -p "$(dirname "${UNIT_PATH}")"
install -m 644 "${UNIT_TMP}" "${UNIT_PATH}"
log "unit 已写入 ${UNIT_PATH}（label=${LABEL}, 随机启动延迟上限=${JITTER}s）"

if [ "${WD_AUTOSTART_PLATFORM}" = "darwin" ]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${UNIT_PATH}" 2>/dev/null ||
    launchctl load -w "${UNIT_PATH}"
  launchctl enable "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  wd_autostart_start
else
  systemctl --user daemon-reload
  systemctl --user enable "$(wd_autostart_unit_name)" >/dev/null
  wd_autostart_start
  log "提示：希望未登录时也常驻，可执行 loginctl enable-linger ${USER}"
fi

if wd_wait_health 40 0.25; then
  log "完成 —— ${WD_HEALTH_URL} 已就绪（随开机/登录自动启动，进程死亡自动拉起）"
else
  echo "[autostart][错误] 服务未在超时内变为健康：${WD_HEALTH_URL}" >&2
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin)
      launchctl print "gui/$(id -u)/${LABEL}" 2>&1 | head -20 >&2 ;;
    linux)
      systemctl --user status "$(wd_autostart_unit_name)" --no-pager 2>&1 | head -20 >&2 ;;
  esac
  exit 1
fi
