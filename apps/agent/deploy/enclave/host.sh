#!/bin/bash
# Runs on the agent host as root: builds the enclave image from the checked-out app, starts it,
# and wires the host side. The host keeps three jobs: relay inbound chat traffic to the enclave,
# relay the enclave's TLS connections to its three allowed hosts, and hand it fresh role
# credentials. It never sees the conversation in clear text past CloudFront's origin hop, and it
# can't read the enclave's memory.
#   host.sh up     build and start (switches traffic from the host service to the enclave)
#   host.sh down   stop the enclave and serve from the host again
set -euo pipefail
APP=/opt/sikrets-agent/src/apps/agent
BUILD=/opt/sikrets-agent/enclave-build
EIF=/opt/sikrets-agent/agent.eif
CID=16
MEM=${ENCLAVE_MEMORY_MIB:-3072}
CPUS=${ENCLAVE_CPUS:-2}

down() {
  systemctl stop sikrets-enclave-feed sikrets-enclave-inbound sikrets-vsock-proxy@8001 sikrets-vsock-proxy@8002 sikrets-vsock-proxy@8003 2>/dev/null || true
  nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
  rm -f /etc/sikrets-agent/attestation.json
  systemctl start sikrets-agent
}

if [ "${1:-up}" = "down" ]; then down; exit 0; fi

dnf install -y -q socat docker >/dev/null
systemctl enable --now docker >/dev/null

# Allocator: reserve the enclave's CPUs and memory.
sed -i "s/^cpu_count:.*/cpu_count: $CPUS/; s/^memory_mib:.*/memory_mib: $MEM/" /etc/nitro_enclaves/allocator.yaml
systemctl restart nitro-enclaves-allocator

# Image: the app (with production dependencies), Bun, and the enclave entrypoint.
rm -rf "$BUILD" && mkdir -p "$BUILD/app"
cp -r "$APP/src" "$APP/public" "$APP/data" "$APP/package.json" "$APP/node_modules" "$BUILD/app/"
cp /opt/sikrets-agent/.bun/bin/bun "$BUILD/bun"
cp "$APP/deploy/enclave/Dockerfile" "$APP/deploy/enclave/run.sh" "$APP/deploy/enclave/bootstrap.py" "$BUILD/"
docker build -q -t sikrets-agent-enclave:latest "$BUILD" >/dev/null
nitro-cli build-enclave --docker-uri sikrets-agent-enclave:latest --output-file "$EIF" > /etc/sikrets-agent/measurements.json

# Outbound: one vsock-proxy per allowed host.
cat > /etc/nitro_enclaves/sikrets-proxy.yaml <<'EOF'
allowlist:
- {address: bedrock-runtime.us-east-1.amazonaws.com, port: 443}
- {address: codeload.github.com, port: 443}
- {address: api.osv.dev, port: 443}
EOF
cat > /etc/systemd/system/sikrets-vsock-proxy@.service <<'EOF'
[Unit]
Description=vsock proxy for the agent enclave (port %i)
[Service]
ExecStart=/bin/bash -c 'case %i in 8001) h=bedrock-runtime.us-east-1.amazonaws.com;; 8002) h=codeload.github.com;; 8003) h=api.osv.dev;; esac; exec /usr/bin/vsock-proxy %i $h 443 --config /etc/nitro_enclaves/sikrets-proxy.yaml'
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

# Credentials: the role's temporary credentials and the access code, sent every 15 minutes.
cat > /usr/local/bin/sikrets-enclave-feed <<'EOF'
#!/usr/bin/env python3
import json, socket, subprocess, time, urllib.request
def imds(path, token):
    req = urllib.request.Request("http://169.254.169.254/latest/" + path, headers={"X-aws-ec2-metadata-token": token})
    return urllib.request.urlopen(req, timeout=5).read().decode()
while True:
    try:
        token = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT", headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}), timeout=5).read().decode()
        role = imds("meta-data/iam/security-credentials/", token).strip()
        creds = json.loads(imds("meta-data/iam/security-credentials/" + role, token))
        code = subprocess.check_output(["aws", "ssm", "get-parameter", "--region", "us-east-1", "--name", "/sikrets-agent-demo/access-code", "--with-decryption", "--query", "Parameter.Value", "--output", "text"]).decode().strip()
        s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect((16, 9000))
        s.sendall(json.dumps({"credentials": {k: creds[k] for k in ("AccessKeyId", "SecretAccessKey", "Token", "Expiration")}, "accessCode": code}).encode())
        s.close()
        time.sleep(900)
    except Exception as e:
        print("feed failed, retrying:", e, flush=True)
        time.sleep(5)
EOF
chmod 755 /usr/local/bin/sikrets-enclave-feed
cat > /etc/systemd/system/sikrets-enclave-feed.service <<'EOF'
[Unit]
Description=Hand the agent enclave fresh credentials
[Service]
ExecStart=/usr/local/bin/sikrets-enclave-feed
Restart=always
EOF

systemctl daemon-reload
nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
nitro-cli run-enclave --eif-path "$EIF" --cpu-count "$CPUS" --memory "$MEM" --enclave-cid $CID ${ENCLAVE_DEBUG:+--debug-mode} > /etc/sikrets-agent/enclave.json
systemctl start sikrets-vsock-proxy@8001 sikrets-vsock-proxy@8002 sikrets-vsock-proxy@8003 sikrets-enclave-feed
systemctl stop sikrets-agent
systemctl start sikrets-enclave-inbound
cat /etc/sikrets-agent/measurements.json
