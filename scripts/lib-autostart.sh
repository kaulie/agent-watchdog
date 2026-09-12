#!/usr/bin/env bash
# Shared autostart helpers — sourced (never executed) by start.sh / stop.sh /
# status.sh / install-autostart.sh / uninstall-autostart.sh.
#
# Contract: when the watchdog is registered with the OS service manager
# (launchd on macOS, systemd --user on Linux) that manager owns the process
# lifetime. Callers must go through these helpers instead of spawning a second
# unsupervised copy.
#
# Paths/labels/unit paths come from src/autostart.ts via dist/autostart-cli.js.

WD_HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"
WD_AUTOSTART_CLI="${WD_HOME_DIR}/dist/autostart-cli.js"
WD_AUTOSTART_PLATFORM="${WATCHDOG_AUTOSTART_PLATFORM:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
WD_HOST="${WATCHDOG_HOST:-127.0.0.1}"
# 只认 WATCHDOG_PORT：绝不回落到环境的 PORT，否则会把被监控应用（web-cursor 用
# PORT=4211）的端口继承进来，导致 watchdog 与它抢/影子同一个端口。
WD_PORT="${WATCHDOG_PORT:-4230}"
WD_HEALTH_URL="http://${WD_HOST}:${WD_PORT}/health"

wd_platform_supported() {
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin | linux) return 0 ;;
    *) return 1 ;;
  esac
}

# True when the OS-level autostart unit has been installed on this machine.
wd_autostart_installed() {
  [ -f "${WD_AUTOSTART_CLI}" ] || return 1
  wd_platform_supported || return 1
  local unit
  unit="$(wd_autostart_field unitPath)" || return 1
  [ -n "${unit}" ] && [ -f "${unit}" ]
}

wd_autostart_field() {
  node "${WD_AUTOSTART_CLI}" info --field "$1" --platform "${WD_AUTOSTART_PLATFORM}" 2>/dev/null
}

wd_autostart_label() {
  wd_autostart_field label
}

wd_autostart_unit_name() {
  wd_autostart_field unitName
}

wd_autostart_unit_path() {
  wd_autostart_field unitPath
}

# True when the OS manager currently supervises the service (running or not).
wd_autostart_loaded() {
  wd_platform_supported || return 1
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin) launchctl print "gui/$(id -u)/$(wd_autostart_label)" >/dev/null 2>&1 ;;
    linux) systemctl --user cat "$(wd_autostart_unit_name)" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

wd_healthy() {
  curl -fsS -m 3 "${WD_HEALTH_URL}" >/dev/null 2>&1
}

# Is this pid one of *our* processes (so install may take it over)?
# Checks cmdline, working directory and the pid file — our own instance runs as
# `node dist/index.js` from inside ${WD_HOME_DIR}, so cmdline alone is not enough.
wd_pid_is_ours() {
  local pid="$1" cmd cwd own
  [ -n "${pid}" ] || return 1
  cmd="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
  case "${cmd}" in
    *"${WD_HOME_DIR}"*) return 0 ;;
  esac
  cwd="$(wd_pid_cwd "${pid}")"
  [ -n "${cwd}" ] && [ "$(wd_realpath "${cwd}")" = "$(wd_realpath "${WD_HOME_DIR}")" ] && return 0
  if [ -f "${WD_HOME_DIR}/watchdog.pid" ]; then
    own="$(cat "${WD_HOME_DIR}/watchdog.pid" 2>/dev/null | tr -d '[:space:]')"
    [ -n "${own}" ] && [ "${own}" = "${pid}" ] && return 0
  fi
  return 1
}

wd_pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# Resolve symlinks (/tmp → /private/tmp on macOS) so path comparisons hold.
wd_realpath() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

wd_pid_cmd() {
  ps -o command= -p "$1" 2>/dev/null || true
}

wd_autostart_start() {
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin)
      local label unit
      label="$(wd_autostart_label)"
      unit="$(wd_autostart_unit_path)"
      if ! launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
        launchctl bootstrap "gui/$(id -u)" "${unit}" 2>/dev/null ||
          launchctl load -w "${unit}"
      fi
      launchctl kickstart "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
      ;;
    linux)
      systemctl --user start "$(wd_autostart_unit_name)"
      ;;
  esac
}

wd_autostart_restart() {
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin) launchctl kickstart -k "gui/$(id -u)/$(wd_autostart_label)" >/dev/null 2>&1 || true ;;
    linux) systemctl --user restart "$(wd_autostart_unit_name)" ;;
  esac
}

# Stop through the OS manager (autostart registration itself stays in place).
wd_autostart_stop() {
  case "${WD_AUTOSTART_PLATFORM}" in
    darwin) launchctl bootout "gui/$(id -u)/$(wd_autostart_label)" >/dev/null 2>&1 || true ;;
    linux) systemctl --user stop "$(wd_autostart_unit_name)" >/dev/null 2>&1 || true ;;
  esac
}

# Poll ${WD_HEALTH_URL} until healthy; $1 = attempts, $2 = sleep seconds.
wd_wait_health() {
  local attempts="${1:-40}" delay="${2:-0.25}" i
  for ((i = 1; i <= attempts; i++)); do
    wd_healthy && return 0
    sleep "${delay}"
  done
  return 1
}
