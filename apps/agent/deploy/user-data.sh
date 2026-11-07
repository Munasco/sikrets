#!/bin/bash
# Boot script for the agent host (Amazon Linux 2023, arm64). Installs Bun, the Nitro Enclaves CLI,
# and the agent (the gateway plus opencode, pinned in package.json) as a systemd service. The
# access code is read from SSM Parameter Store at start, so it never sits in user data or on disk.
#
# It deploys one commit, never a branch: deploy/aws.sh resolves DEPLOY_REF (a tag or a commit SHA)
# to a SHA and fills in the two values below. The checkout must land on exactly that SHA, or the
# boot stops before anything is installed.
set -euxo pipefail
REPO=https://github.com/Munasco/sikrets.git
REF=__DEPLOY_REF__
SHA=__DEPLOY_SHA__
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "no commit SHA to deploy (ref $REF)"; exit 1; }

dnf install -y git unzip aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel
useradd --system --create-home --home-dir /opt/sikrets-agent sikrets || true
usermod -aG ne sikrets || true

sudo -u sikrets bash -c 'curl -fsSL https://bun.sh/install | bash'
sudo -u sikrets bash -c "set -e
  git init -q /opt/sikrets-agent/src && cd /opt/sikrets-agent/src
  git remote add origin '$REPO'
  git fetch -q --depth 1 origin '$SHA'
  git checkout -q --detach FETCH_HEAD"
got=$(sudo -u sikrets git -C /opt/sikrets-agent/src rev-parse HEAD)
[ "$got" = "$SHA" ] || { echo "checkout is $got, expected $SHA ($REF)"; exit 1; }
sudo -u sikrets bash -c 'cd /opt/sikrets-agent/src/apps/agent && ~/.bun/bin/bun install --frozen-lockfile --production && ~/.bun/bin/bun run build:ui'

mkdir -p /etc/sikrets-agent
install -m 755 /opt/sikrets-agent/src/apps/agent/deploy/agent-env.sh /usr/local/bin/sikrets-agent-env

cat > /etc/systemd/system/sikrets-agent.service <<'EOF'
[Unit]
Description=Sikrets security agent
After=network-online.target
Wants=network-online.target

[Service]
User=sikrets
WorkingDirectory=/opt/sikrets-agent/src/apps/agent
ExecStartPre=+/usr/local/bin/sikrets-agent-env
Environment=HOST=0.0.0.0 PORT=8787 OPENCODE_HOME=/tmp/sikrets-opencode
ExecStart=/bin/bash -c 'set -a; . /run/sikrets-agent.env; exec /opt/sikrets-agent/.bun/bin/bun src/server.ts'
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/tmp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# Enclave allocator: 2 vCPUs and 2 GiB for an enclave, leaving the rest to the host.
sed -i 's/^cpu_count:.*/cpu_count: 2/; s/^memory_mib:.*/memory_mib: 2048/' /etc/nitro_enclaves/allocator.yaml
systemctl enable --now nitro-enclaves-allocator.service || true

systemctl daemon-reload
systemctl enable --now sikrets-agent.service
