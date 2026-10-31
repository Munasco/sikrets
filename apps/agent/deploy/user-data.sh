#!/bin/bash
# Boot script for the agent host (Amazon Linux 2023, arm64). Installs Bun, the Nitro Enclaves CLI,
# and the agent as a systemd service. The access code is read from SSM Parameter Store at start,
# so it never sits in user data or on disk.
set -euxo pipefail
REPO=https://github.com/Munasco/sikrets.git
BRANCH=feat/agent-demo

dnf install -y git unzip aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel
useradd --system --create-home --home-dir /opt/sikrets-agent sikrets || true
usermod -aG ne sikrets || true

sudo -u sikrets bash -c 'curl -fsSL https://bun.sh/install | bash'
sudo -u sikrets git clone --depth 1 --branch "$BRANCH" "$REPO" /opt/sikrets-agent/src
sudo -u sikrets bash -c 'cd /opt/sikrets-agent/src/apps/agent && ~/.bun/bin/bun install --frozen-lockfile --production'

mkdir -p /etc/sikrets-agent
cat > /usr/local/bin/sikrets-agent-env <<'EOF'
#!/bin/bash
# Writes the runtime env file (tmpfs) from SSM; the service reads it at start.
set -euo pipefail
code=$(aws ssm get-parameter --region us-east-1 --name /sikrets-agent-demo/access-code --with-decryption --query Parameter.Value --output text)
umask 077
printf 'ACCESS_CODE=%s\n' "$code" > /run/sikrets-agent.env
chown sikrets /run/sikrets-agent.env
EOF
chmod 755 /usr/local/bin/sikrets-agent-env

cat > /etc/systemd/system/sikrets-agent.service <<'EOF'
[Unit]
Description=Sikrets security agent
After=network-online.target
Wants=network-online.target

[Service]
User=sikrets
WorkingDirectory=/opt/sikrets-agent/src/apps/agent
PermissionsStartOnly=true
ExecStartPre=/usr/local/bin/sikrets-agent-env
EnvironmentFile=/run/sikrets-agent.env
Environment=HOST=0.0.0.0 PORT=8787 BEDROCK_REGION=us-east-1
ExecStart=/opt/sikrets-agent/.bun/bin/bun src/server.ts
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
