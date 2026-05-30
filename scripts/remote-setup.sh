#!/usr/bin/env zsh
# Runs ON the host machine. Build+run the container in OrbStack, add a Tailscale
# serve mapping (add-only), install the host CLI + the diff-review skill. Idempotent.
#
# Inputs (exported by deploy.sh over ssh, with safe local-only defaults):
#   CODEX_REVIEW_PUBLIC_URL  the URL the phone opens (e.g. https://<host>.<tailnet>.ts.net:7443)
#   TS_PORT                  the tailscale serve https port (default 7443)
set -e
export PATH="/opt/homebrew/bin:$HOME/.orbstack/bin:$PATH"

: "${CODEX_REVIEW_PUBLIC_URL:=http://127.0.0.1:7799}"
: "${TS_PORT:=7443}"

cd ~/dev/codex-mobile-review

echo "  · qrencode (for the inline QR in the CLI)"
command -v qrencode >/dev/null 2>&1 || brew install qrencode || true

echo "  · docker compose up -d --build"
docker compose up -d --build

echo "  · waiting for health"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:7799/api/health >/dev/null 2>&1; then echo "    healthy"; break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:7799/api/health && echo

echo "  · tailscale serve (add-only on :${TS_PORT})"
tailscale serve --bg --https="${TS_PORT}" http://127.0.0.1:7799 || true
tailscale serve status | sed "s/^/    /"

echo "  · install host config + CLI symlink"
mkdir -p ~/.config/codex-review
cat > ~/.config/codex-review/env <<EOF
export PATH="/opt/homebrew/bin:\$PATH"
export CODEX_REVIEW_SERVER="http://127.0.0.1:7799"
export CODEX_REVIEW_PUBLIC_URL="${CODEX_REVIEW_PUBLIC_URL}"
EOF
chmod +x ~/dev/codex-mobile-review/bin/codex-review
ln -sf ~/dev/codex-mobile-review/bin/codex-review /opt/homebrew/bin/codex-review
echo "    codex-review -> $(readlink /opt/homebrew/bin/codex-review)"

echo "  · install diff-review skill (overrides any older diff-review)"
rm -rf ~/.codex/skills/codex-review
mkdir -p ~/.codex/skills/diff-review
cp -f ~/dev/codex-mobile-review/skill/SKILL.md ~/.codex/skills/diff-review/SKILL.md
echo "    skill at ~/.codex/skills/diff-review/SKILL.md"

echo "  · CLI health via wrapper"
codex-review health
