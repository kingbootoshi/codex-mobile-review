#!/usr/bin/env bash
# Deploy Codex Mobile Review to a host machine over SSH + Tailscale:
# rsync the repo, then run remote-setup.sh on the host (build+run container in
# OrbStack, tailscale serve add-only, install host CLI + diff-review skill).
# Idempotent — safe to re-run.
#
# Configure via env (no private hostnames are baked into this file):
#   MINI      ssh host alias for the machine running the server   (default: mini)
#   TS_HOST   the host's tailnet MagicDNS name the phone opens     (required)
#             e.g. my-host.tailXXXX.ts.net
#   TS_PORT   the tailscale serve https port                       (default: 7443)
set -euo pipefail

MINI="${MINI:-mini}"
TS_PORT="${TS_PORT:-7443}"
TS_HOST="${TS_HOST:?set TS_HOST to your host's tailnet MagicDNS name, e.g. my-host.tailXXXX.ts.net}"
PUBLIC_URL="https://${TS_HOST}:${TS_PORT}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▸ rsync → ${MINI}:~/dev/codex-mobile-review"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude data \
  --exclude design-catalogue --exclude '.DS_Store' --exclude 'bun.lock' \
  "$HERE"/ "${MINI}:dev/codex-mobile-review/"

echo "▸ remote: build + run container, tailscale serve, install CLI + skill"
ssh "$MINI" "CODEX_REVIEW_PUBLIC_URL='${PUBLIC_URL}' TS_PORT='${TS_PORT}' zsh -l ~/dev/codex-mobile-review/scripts/remote-setup.sh"

echo "▸ cross-tailnet health from this machine"
curl -fsS "${PUBLIC_URL}/api/health" && echo
echo "✓ deployed. Phone URL: ${PUBLIC_URL}"
