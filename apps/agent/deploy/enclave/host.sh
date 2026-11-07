#!/bin/bash
# Runs on the agent host as root: builds the enclave image from the checked-out app, starts it,
# and wires the host side. The host keeps three jobs: relay inbound chat traffic to the enclave,
# relay the enclave's TLS connections to its allowed hosts (the model API, GitHub, OSV, KMS), and
# hand it the access code, the model API key's KMS ciphertext and temporary AWS credentials. The
# enclave decrypts the key itself through KMS with an attestation document; the key policy only
# allows that for this image's PCR0, so the host never sees the key. It never sees the conversation
# in clear text past CloudFront's origin hop, and it can't read the enclave's memory.
#   host.sh build     build the new image beside the running one and print its measurements; the
#                     running enclave keeps serving. Pin the new PCR0 alongside the old one
#                     (ENCLAVE_PCR0=<old>,<new> deploy/aws.sh) before `up`, so there's no gap.
#   host.sh up        start the image `build` made from this checkout (or build one first); the
#                     old one becomes .prev once the new one answers /healthz, else it comes back
#   host.sh rollback  start the previous image again (its PCR0 must still be pinned); the one it
#                     replaces is set aside as .rejected, never started again by itself
#   host.sh down      stop the enclave and serve from the host again
# The image slots and the switch between them are in images.sh. FORCE=1 skips the checks that the
# image is from this checkout and that the KMS key allows it.
set -euo pipefail
APP=/opt/sikrets-agent/src/apps/agent
SRC=/opt/sikrets-agent/src
BUN=/opt/sikrets-agent/.bun/bin/bun
BUILD=/opt/sikrets-agent/enclave-build
EIF=/opt/sikrets-agent/agent.eif
STATE=/etc/sikrets-agent
NAME=sikrets-agent-demo
CID=16
# shellcheck source=allocator.env
. "$APP/deploy/enclave/allocator.env"
MEM=${ENCLAVE_MEMORY_MIB:-$ENCLAVE_MEMORY_MIB_DEFAULT}
CPUS=${ENCLAVE_CPUS:-$ENCLAVE_CPUS_DEFAULT}
# How long a new enclave gets to answer /healthz (model key decrypted) before it's rolled back.
UP_WAIT=${UP_WAIT_SECONDS:-300}
export HOME=${HOME:-/root} NITRO_CLI_ARTIFACTS=/opt/sikrets-agent/eif-artifacts
mkdir -p "$NITRO_CLI_ARTIFACTS" "$STATE"
install -m 755 "$APP/deploy/agent-env.sh" /usr/local/bin/sikrets-agent-env
# shellcheck source=images.sh
. "$APP/deploy/enclave/images.sh"

# Outbound hosts, one vsock port each. The model host comes from src/constants.ts, so switching
# models there also switches what the enclave may reach.
MODEL_HOST=$(cd "$APP" && "$BUN" -e 'import { MODEL } from "./src/constants.ts"; console.log(MODEL.host)')
# The enclave's own HTTPS hostname, and the ACME server it gets its certificate from (TLS).
read -r TLS_HOST ACME_HOST < <(cd "$APP" && "$BUN" -e 'import { TLS } from "./src/constants.ts"; console.log(TLS.host, TLS.acmeHost)')
REGION=us-east-1
HOSTS=("$MODEL_HOST" codeload.github.com api.osv.dev "kms.$REGION.amazonaws.com" "$ACME_HOST")
PORTS=() PROXIES=()
for i in "${!HOSTS[@]}"; do PORTS+=($((8001 + i))); PROXIES+=("sikrets-vsock-proxy@$((8001 + i))"); done
UNITS=("${PROXIES[@]}" sikrets-enclave-feed sikrets-enclave-inbound sikrets-enclave-tcp-443 sikrets-enclave-tcp-80 sikrets-enclave-watch)

down() {
  systemctl disable --now sikrets-enclave-watch sikrets-enclave sikrets-enclave-feed sikrets-enclave-inbound sikrets-enclave-tcp-443 sikrets-enclave-tcp-80 "${PROXIES[@]}" 2>/dev/null || true
  nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
  systemctl enable --now sikrets-agent
  echo "serving from the host; the enclave-health alarm fires until the enclave is back (host.sh up)"
}

if [ "${1:-up}" = "down" ]; then down; exit 0; fi
MODE=${1:-up}
case "$MODE" in build|up|rollback) ;; *) echo "usage: host.sh build|up|rollback|down"; exit 1 ;; esac

# --- What images.sh needs from the host.
head_sha() { runuser -u sikrets -- git -C "$SRC" rev-parse HEAD; }
# The PCR0s the KMS key allows, as deploy/aws.sh last set them (SSM /$NAME/pinned-pcr0).
pinned_pcr0s() {
  aws ssm get-parameter --region "$REGION" --name "/$NAME/pinned-pcr0" --query Parameter.Value --output text |
    python3 -c 'import json, sys; print("\n".join(json.load(sys.stdin)["pcr0"]))'
}
stop_enclave() {
  systemctl stop sikrets-enclave-watch sikrets-enclave 2>/dev/null || true
  nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
}
start_enclave() {
  # Allocator: reserve the enclave's CPUs and memory (it can't change while an enclave runs).
  # The enclave is stopped first, or restarting the allocator restarts it with the old image.
  sed -i "s/^cpu_count:.*/cpu_count: $CPUS/; s/^memory_mib:.*/memory_mib: $MEM/" /etc/nitro_enclaves/allocator.yaml
  systemctl restart nitro-enclaves-allocator
  systemctl daemon-reload
  systemctl disable --now sikrets-agent
  systemctl enable sikrets-enclave "${UNITS[@]}" >/dev/null 2>&1
  systemctl restart sikrets-enclave
  systemctl restart "${UNITS[@]}"
}
healthy() {
  local deadline=$((SECONDS + UP_WAIT))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS -m 10 -o /dev/null http://127.0.0.1:8787/healthz; then return 0; fi
    sleep 5
  done
  curl -sS -m 10 http://127.0.0.1:8787/healthz >&2 || true
  return 1
}
# The instance's DeployedSha tag follows what's running, not only what it was created with.
deployed() {
  local token id
  token=$(curl -fsS -m 5 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
  id=$(curl -fsS -m 5 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/instance-id)
  aws ec2 create-tags --region "$REGION" --resources "$id" --tags "Key=DeployedSha,Value=$1" || echo "couldn't update the DeployedSha tag" >&2
}
fallback() { systemctl enable --now sikrets-agent; }

SWAP=/opt/sikrets-agent/build.swap
SWAP_ON=""
# On any exit: a switch that didn't finish is undone, and the build's swap file is removed.
cleanup() {
  undo_switch
  if [ -n "$SWAP_ON" ]; then swapoff "$SWAP" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

dnf install -y -q socat docker >/dev/null
systemctl enable --now docker >/dev/null

build() {
# Whatever was built before goes first: a build that fails must not leave an older image to start.
clear_slot new
# The running enclave keeps serving while the new image builds. Building an EIF takes more memory
# than the host has left beside the enclave's reservation, so a swap file covers it for the build.
if ! swapon --show=NAME --noheadings | grep -q .; then
  rm -f "$SWAP"
  fallocate -l 6G "$SWAP" && chmod 600 "$SWAP" && mkswap "$SWAP" >/dev/null
  swapon "$SWAP"
  SWAP_ON=1
fi
local sha
sha=$(head_sha)

# Image: the app (with production dependencies, opencode's glibc build only), the built chat page,
# Bun, the entrypoint, and the host list the entrypoint maps to vsock ports.
runuser -u sikrets -- bash -c "cd '$APP' && '$BUN' run build:ui" >/dev/null
rm -rf "$BUILD" && mkdir -p "$BUILD/app/ui"
cp -r "$APP/src" "$APP/plugin" "$APP/data" "$APP/skills" "$APP/package.json" "$APP/node_modules" "$BUILD/app/"
# MCP servers, if the operator configured any (src/capabilities.ts).
if [ -f "$APP/mcp.json" ]; then cp "$APP/mcp.json" "$BUILD/app/"; fi
cp -r "$APP/ui/dist" "$BUILD/app/ui/"
rm -rf "$BUILD"/app/node_modules/@opencode/cli-*-musl
cp "$BUN" "$BUILD/bun"
cp "$APP/deploy/enclave/Dockerfile" "$APP/deploy/enclave/run.sh" "$APP/deploy/enclave/bootstrap.py" "$BUILD/"
: > "$BUILD/hosts"
for i in "${!HOSTS[@]}"; do echo "127.0.0.$((11 + i)) ${HOSTS[$i]} ${PORTS[$i]}" >> "$BUILD/hosts"; done
# In the image, so the hostname the enclave gets a certificate for is part of its measurements.
echo "$TLS_HOST" > "$BUILD/tls-host"
docker build -q -t sikrets-agent-enclave:latest "$BUILD" >/dev/null
# Built beside the running image (the new slot); `up` swaps it in.
nitro-cli build-enclave --docker-uri sikrets-agent-enclave:latest --output-file "$(slot_eif new)" > "$(slot_meas new).tmp"
mv -f "$(slot_meas new).tmp" "$(slot_meas new)"
complete new || { clear_slot new; echo "enclave build failed; the running enclave is unchanged"; exit 1; }
# Last: the slot only counts as built from this commit once everything else is in place.
echo "$sha" > "$(slot_sha new)"
}

# An earlier run that died midway through a switch is undone before anything else.
resume_switch

if [ "$MODE" = build ]; then build; cat "$(slot_meas new)"; echo "built from $(slot_commit new)"; exit 0; fi
if [ "$MODE" = up ]; then
  complete new || build
  rc=0; check_new || rc=$?
  if [ $rc = 2 ]; then exit 1; elif [ $rc != 0 ]; then echo "no image to start"; exit 1; fi
  check_pinned new
else
  complete prev || { echo "no previous image to roll back to"; exit 1; }
  check_pinned prev
fi

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

# Inbound: CloudFront → host :8787 → enclave vsock 8787 (plain HTTP on CloudFront's origin hop).
# And the load balancer's TCP passthrough: :443 → vsock 8443, still TLS, ended inside the enclave;
# :80 → vsock 8080, the certificate's HTTP-01 challenge and a redirect to HTTPS.
cat > /etc/systemd/system/sikrets-enclave-inbound.service <<EOF
[Unit]
Description=Relay chat traffic into the agent enclave
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:8787,fork,reuseaddr VSOCK-CONNECT:$CID:8787
Restart=always
EOF
for pair in 443:8443 80:8080; do
  cat > /etc/systemd/system/sikrets-enclave-tcp-${pair%%:*}.service <<EOF
[Unit]
Description=Relay TCP :${pair%%:*} into the agent enclave (vsock ${pair##*:}); the host sees only TLS
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:${pair%%:*},fork,reuseaddr VSOCK-CONNECT:$CID:${pair##*:}
Restart=always
EOF
done

# Secrets: the access code (SSM SecureString), the model key's KMS ciphertext (SSM String) and the
# instance role's temporary credentials, sent every 15 minutes so a rotated value reaches the
# enclave without a rebuild. The enclave answers with a status (never a secret), logged here; until
# the key and the certificate are both fine (or after a failure), the feed retries every minute.
cat > /usr/local/bin/sikrets-enclave-feed <<'EOF'
#!/usr/bin/env python3
import json, os, socket, subprocess, time, urllib.request
REGION = "us-east-1"
# The enclave's sealed TLS key (KMS ciphertext only it can open) and its public certificate.
TLS_STORE = "/etc/sikrets-agent/tls.json"
def param(name, decrypt=True):
    return subprocess.check_output(["aws", "ssm", "get-parameter", "--region", REGION, "--name", "/sikrets-agent-demo/" + name] + (["--with-decryption"] if decrypt else []) + ["--query", "Parameter.Value", "--output", "text"]).decode().strip()
def imds(path, token=None):
    req = urllib.request.Request("http://169.254.169.254/latest/" + path, method="PUT" if token is None else "GET")
    if token is None:
        req.add_header("X-aws-ec2-metadata-token-ttl-seconds", "300")
    else:
        req.add_header("X-aws-ec2-metadata-token", token)
    return urllib.request.urlopen(req, timeout=5).read().decode()
def credentials():
    token = imds("api/token")
    role = imds("meta-data/iam/security-credentials/", token).strip()
    c = json.loads(imds("meta-data/iam/security-credentials/" + role, token))
    return {"AccessKeyId": c["AccessKeyId"], "SecretAccessKey": c["SecretAccessKey"], "Token": c["Token"]}
while True:
    try:
        tls = json.load(open(TLS_STORE)) if os.path.exists(TLS_STORE) else None
        msg = json.dumps({"accessCode": param("access-code"), "modelKeyCiphertext": param("model-key-ciphertext", False), "credentials": credentials(), "region": REGION, "now": time.time(), "tls": tls}).encode()
        s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        s.settimeout(60)
        s.connect((16, 9000))
        s.sendall(msg)
        s.shutdown(socket.SHUT_WR)
        del msg
        reply = b""
        while chunk := s.recv(4096):
            reply += chunk
        s.close()
        status = json.loads(reply or b"{}")
        store = status.pop("tlsStore", None)
        if store:
            with open(TLS_STORE + ".tmp", "w") as f:
                json.dump(store, f)
            os.replace(TLS_STORE + ".tmp", TLS_STORE)
            status["tlsStore"] = "saved"
        print("enclave:", json.dumps(status), flush=True)
        # Soon again while the certificate is being issued, or a new one wasn't handed back yet.
        # "off": the image has no TLS hostname, so there's nothing to wait for.
        time.sleep(900 if status.get("modelKey") == "ok" and status.get("tls") in ("ok", "off") and not store else 60)
    except Exception as e:
        print("feed failed, retrying in a minute:", type(e).__name__, flush=True)
        time.sleep(60)
EOF
chmod 755 /usr/local/bin/sikrets-enclave-feed
cat > /etc/systemd/system/sikrets-enclave-feed.service <<'EOF'
[Unit]
Description=Hand the agent enclave its access code and the model key's ciphertext
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
# Watch: an enclave that exits (it can't be inspected in production mode) is started again, and so
# is one whose gateway hasn't answered at all for 5 minutes. Every minute it also sends a heartbeat
# to CloudWatch: 1 if the enclave runs and its gateway's /healthz is fine (model key and
# certificate), else 0. An alarm (deploy/aws.sh) fires on 0 or on no heartbeat at all. A /healthz
# that answers with a problem (503) only alarms: restarting wouldn't fix a key KMS refuses, and
# would ask Let's Encrypt for another certificate.
cat > /usr/local/bin/sikrets-enclave-watch <<'EOF'
#!/bin/bash
silent=0
while sleep 60; do
  healthy=1
  if ! nitro-cli describe-enclaves | grep -q RUNNING; then
    healthy=0
    silent=0
    echo "enclave not running; restarting"
    systemctl restart sikrets-enclave
    systemctl restart sikrets-enclave-feed
  else
    code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz 2>/dev/null || true)
    [ "$code" = 200 ] || healthy=0
    if [ "$code" = 000 ] || [ -z "$code" ]; then silent=$((silent + 1)); else silent=0; fi
    if [ $silent -ge 5 ]; then
      echo "the gateway hasn't answered for 5 minutes; restarting the enclave"
      silent=0
      systemctl restart sikrets-enclave
      systemctl restart sikrets-enclave-feed
    fi
  fi
  aws cloudwatch put-metric-data --region us-east-1 --namespace Sikrets/AgentDemo --metric-name EnclaveHealthy --value $healthy --unit Count || true
done
EOF
chmod 755 /usr/local/bin/sikrets-enclave-watch
cat > /etc/systemd/system/sikrets-enclave-watch.service <<'EOF'
[Unit]
Description=Restart the agent enclave if it stops running, and report its health
After=sikrets-enclave.service
[Service]
ExecStart=/usr/local/bin/sikrets-enclave-watch
Restart=always
EOF

for u in sikrets-vsock-proxy@ sikrets-enclave-inbound sikrets-enclave-tcp-443 sikrets-enclave-tcp-80 sikrets-enclave-feed sikrets-enclave-watch; do
  f=/etc/systemd/system/$u.service
  grep -q '^\[Install\]' "$f" || printf '[Install]\nWantedBy=multi-user.target\n' >> "$f"
done

if [ "$MODE" = up ]; then switch new prev; else switch prev rejected; fi
cat "$(slot_meas cur)"
