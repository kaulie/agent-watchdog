#!/usr/bin/env bash
# Build a release package into ./outputs/.
#
# This is the hook the deployment control plane expects: `release.sh` archives
# the repo, runs this script, then rsyncs `outputs/` to the service runtimeDir
# described by the SQLite service contract.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

[ -f package.json ] || {
  echo "[build][错误] package.json missing" >&2
  exit 1
}

echo "[build] npm install + tsc"
npm install --no-audit --no-fund
npm run build

echo "[build] staging outputs/"
rm -rf outputs
mkdir -p outputs
cp -R dist outputs/dist
cp -R scripts outputs/scripts
cp -R src outputs/src
cp package.json package-lock.json tsconfig.json outputs/
cp README.md AGENT.md outputs/ 2>/dev/null || true

echo "[build] production dependencies"
(cd outputs && npm install --omit=dev --no-audit --no-fund)

printf '%s\n' "${APP_VERSION:-dev}" > outputs/VERSION

echo "[build] outputs ready ($(du -sh outputs | cut -f1))"
