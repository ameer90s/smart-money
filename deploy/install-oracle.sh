#!/usr/bin/env bash
# One-time setup on an Ubuntu server (Oracle Always Free or any VPS). Runs the engine 24/5
# as a systemd service. Usage (as a sudo user):
#   curl -fsSL https://raw.githubusercontent.com/<owner>/smart-money/main/deploy/install-oracle.sh | bash -s <owner>/smart-money
set -euo pipefail
REPO="${1:?usage: install-oracle.sh owner/repo}"
DIR=/opt/smart-money

sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR"
[ -d "$DIR/.git" ] || git clone -q "https://github.com/${REPO}.git" "$DIR"

ENVF=/etc/smart-money.env
if [ ! -f "$ENVF" ]; then
  sudo tee "$ENVF" >/dev/null <<EOF
# Fill these in, then: sudo systemctl restart smart-money
ALPACA_KEY=
ALPACA_SECRET=
FINNHUB_KEY=
NTFY_TOPIC=
GIST_ID=
GIST_TOKEN=
ANTHROPIC_API_KEY=
APP_URL=
# Token with "Contents: read and write" on ${REPO}, used to back data up to the data branch
DATA_PUSH_TOKEN=
DATA_DIR=${DIR}/data
GIT_SYNC=1
RUNNER_NAME=oracle
EOF
  sudo chmod 600 "$ENVF"
fi

sudo tee /etc/systemd/system/smart-money.service >/dev/null <<EOF
[Unit]
Description=Smart Money engine
After=network-online.target
Wants=network-online.target

[Service]
User=${USER}
WorkingDirectory=${DIR}
EnvironmentFile=${ENVF}
ExecStartPre=/bin/bash -c 'cd ${DIR} && git pull -q || true; if [ ! -d ${DIR}/data/.git ]; then U="https://x-access-token:\${DATA_PUSH_TOKEN}@github.com/${REPO}.git"; git clone -q --depth 1 --branch data "\$U" ${DIR}/data || (mkdir -p ${DIR}/data && cd ${DIR}/data && git init -q -b data && git remote add origin "\$U"); fi'
ExecStart=/usr/bin/node engine/main.js
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable smart-money
echo
echo "Installed. Edit ${ENVF} with your keys, then run: sudo systemctl restart smart-money"
echo "Logs: journalctl -u smart-money -f"
