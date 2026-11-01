#!/bin/bash
# Runs on the agent host as root: builds the enclave image from the checked-out app, starts it,
# and wires the host side. The host keeps three jobs: relay inbound chat traffic to the enclave,
# relay the enclave's TLS connections to its allowed hosts (the model API, GitHub, OSV), and hand
# it the access code and the model API key. It never sees the conversation in clear text past
# CloudFront's origin hop, and it can't read the enclave's memory. It does read the model key from
# SSM to pass it on, so whoever controls the host can use that key; that's this demo's trust gap.
#   host.sh up     build and start (switches traffic from the host service to the enclave)
#   host.sh down   stop the enclave and serve from the host again
set -euo pipefail
APP=/opt/sikrets-agent/src/apps/agent
BUN=/opt/sikrets-agent/.bun/bin/bun
BUILD=/opt/sikrets-agent/enclave-build
EIF=/opt/sikrets-agent/agent.eif
CID=16
MEM=${ENCLAVE_MEMORY_MIB:-4096}
CPUS=${ENCLAVE_CPUS:-2}
export HOME=${HOME:-/root} NITRO_CLI_ARTIFACTS=/opt/sikrets-agent/eif-artifacts
mkdir -p "$NITRO_CLI_ARTIFACTS"
install -m 755 "$APP/deploy/agent-env.sh" /usr/local/bin/sikrets-agent-env

# Outbound hosts, one vsock port each. The model host comes from src/constants.ts, so switching
# models there also switches what the enclave may reach.
MODEL_HOST=$(cd "$APP" && "$BUN" -e 'import { MODEL } from "./src/constants.ts"; console.log(MODEL.host)')
HOSTS=("$MODEL_HOST" codeload.github.com api.osv.dev)
PORTS=() PROXIES=()
for i in "${!HOSTS[@]}"; do PORTS+=($((8001 + i))); PROXIES+=("sikrets-vsock-proxy@$((8001 + i))"); done

down() {
  systemctl disable --now sikrets-enclave sikrets-enclave-feed sikrets-enclave-inbound "${PROXIES[@]}" 2>/dev/null || true
  nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
  systemctl enable --now sikrets-agent
}

if [ "${1:-up}" = "down" ]; then down; exit 0; fi

dnf install -y -q socat docker >/dev/null
systemctl enable --now docker >/dev/null

# Allocator: reserve the enclave's CPUs and memory (it can't change while an enclave runs).
nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
sed -i "s/^cpu_count:.*/cpu_count: $CPUS/; s/^memory_mib:.*/memory_mib: $MEM/" /etc/nitro_enclaves/allocator.yaml
systemctl restart nitro-enclaves-allocator

# Image: the app (with production dependencies, opencode's glibc build only), Bun, the entrypoint,
# and the host list the entrypoint maps to vsock ports.
rm -rf "$BUILD" && mkdir -p "$BUILD/app"
cp -r "$APP/src" "$APP/plugin" "$APP/public" "$APP/data" "$APP/package.json" "$APP/node_modules" "$BUILD/app/"
rm -rf "$BUILD"/app/node_modules/@opencode/cli-*-musl
cp "$BUN" "$BUILD/bun"
cp "$APP/deploy/enclave/Dockerfile" "$APP/deploy/enclave/run.sh" "$APP/deploy/enclave/bootstrap.py" "$BUILD/"
: > "$BUILD/hosts"
for i in "${!HOSTS[@]}"; do echo "127.0.0.$((11 + i)) ${HOSTS[$i]} ${PORTS[$i]}" >> "$BUILD/hosts"; done
docker build -q -t sikrets-agent-enclave:latest "$BUILD" >/dev/null
nitro-cli build-enclave --docker-uri sikrets-agent-enclave:latest --output-file "$EIF" > /etc/sikrets-agent/measurements.json

# Outbound: one vsock-proxy per allowed host.
{
  echo "allowlist:"
  for h in "${HOSTS[@]}"; do echo "- {address: $h, port: 443}"; done
} > /etc/nitro_enclaves/sikrets-proxy.yaml
: > /etc/nitro_enclaves/sikrets-ports
for i in "${!HOSTS[@]}"; do echo "${PORTS[$i]} ${HOSTS[$i]}" >> /etc/nitro_enclaves/sikrets-ports; done
cat > /usr/local/bin/sikrets-vsock-proxy <<'EOF'
#!/bin/bash
# sikrets-vsock-proxy <port>: relays that vsock port to its one allowed host.
set -euo pipefail
host=$(awk -v p="$1" '$1 == p { print $2 }' /etc/nitro_enclaves/sikrets-ports)
exec /usr/bin/vsock-proxy "$1" "$host" 443 --config /etc/nitro_enclaves/sikrets-proxy.yaml
EOF
chmod 755 /usr/local/bin/sikrets-vsock-proxy
cat > /etc/systemd/system/sikrets-vsock-proxy@.service <<'EOF'
[Unit]
Description=vsock proxy for the agent enclave (port %i)
[Service]
ExecStart=/usr/local/bin/sikrets-vsock-proxy %i
Restart=always
EOF

# Inbound: CloudFront → host :8787 → enclave vsock 8787.
cat > /etc/systemd/system/sikrets-enclave-inbound.service <<EOF
[Unit]
Description=Relay chat traffic into the agent enclave
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:8787,fork,reuseaddr VSOCK-CONNECT:$CID:8787
Restart=always
EOF

# Secrets: the access code and the model API key from SSM, sent every 15 minutes so a rotated
# value reaches the enclave without a rebuild.
cat > /usr/local/bin/sikrets-enclave-feed <<'EOF'
#!/usr/bin/env python3
import json, socket, subprocess, time
def param(name):
    return subprocess.check_output(["aws", "ssm", "get-parameter", "--region", "us-east-1", "--name", "/sikrets-agent-demo/" + name, "--with-decryption", "--query", "Parameter.Value", "--output", "text"]).decode().strip()
while True:
    try:
        msg = json.dumps({"accessCode": param("access-code"), "modelKey": param("model-key")}).encode()
        s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect((16, 9000))
        s.sendall(msg)
        s.close()
        del msg
        time.sleep(900)
    except Exception as e:
        print("feed failed, retrying:", type(e).__name__, flush=True)
        time.sleep(5)
EOF
chmod 755 /usr/local/bin/sikrets-enclave-feed
cat > /etc/systemd/system/sikrets-enclave-feed.service <<'EOF'
[Unit]
Description=Hand the agent enclave its access code and model key
[Service]
ExecStart=/usr/local/bin/sikrets-enclave-feed
Restart=always
EOF

# The enclave itself, owned by systemd so it outlives this script and comes back after a reboot.
cat > /etc/systemd/system/sikrets-enclave.service <<EOF
[Unit]
Description=Sikrets agent Nitro Enclave
After=nitro-enclaves-allocator.service
Requires=nitro-enclaves-allocator.service
[Service]
Type=oneshot
RemainAfterExit=true
Environment=HOME=/root NITRO_CLI_ARTIFACTS=/opt/sikrets-agent/eif-artifacts
ExecStartPre=-/usr/bin/nitro-cli terminate-enclave --all
ExecStart=/bin/bash -c '/usr/bin/nitro-cli run-enclave --eif-path $EIF --cpu-count $CPUS --memory $MEM --enclave-cid $CID ${ENCLAVE_DEBUG:+--debug-mode} > /etc/sikrets-agent/enclave.json'
ExecStop=/usr/bin/nitro-cli terminate-enclave --all
[Install]
WantedBy=multi-user.target
EOF
for u in sikrets-vsock-proxy@ sikrets-enclave-inbound sikrets-enclave-feed; do
  f=/etc/systemd/system/$u.service
  grep -q '^\[Install\]' $f || printf '[Install]\nWantedBy=multi-user.target\n' >> $f
done

systemctl daemon-reload
systemctl disable --now sikrets-agent
systemctl enable sikrets-enclave "${PROXIES[@]}" sikrets-enclave-feed sikrets-enclave-inbound >/dev/null 2>&1
systemctl restart sikrets-enclave
systemctl restart "${PROXIES[@]}" sikrets-enclave-feed sikrets-enclave-inbound
cat /etc/sikrets-agent/measurements.json
