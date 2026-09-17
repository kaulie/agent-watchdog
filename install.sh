#!/usr/bin/env bash
# Install + (re)start the independent watchdog service.
#
#   git clone https://github.com/kaulie/agent-watchdog
#   cd agent-watchdog
#   ./install.sh
#   # → ~/runtime/agent-watchdog, HTTP :4230
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${WATCHDOG_HOME:-${HOME}/runtime/agent-watchdog}"

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

echo "[install] (re)starting service..."
WATCHDOG_HOME="${HOME_DIR}" "${HOME_DIR}/scripts/restart.sh"

echo "[install] done — API http://127.0.0.1:${SERVICE_PORT:-${WATCHDOG_PORT:-4230}}/health"
