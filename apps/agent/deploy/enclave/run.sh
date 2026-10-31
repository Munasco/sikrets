#!/bin/sh
# Enclave entrypoint. An enclave has no network, only vsock to its host. Loopback aliases stand in
# for the three hosts the agent talks to; each is forwarded over vsock to a host-side vsock-proxy
# that only allows that one host. TLS runs end to end from inside the enclave, so the host relays
# encrypted bytes it can't read.
set -e
ip addr add 127.0.0.1/8 dev lo 2>/dev/null || true
ip link set dev lo up
cat > /etc/hosts <<HOSTS
127.0.0.1 localhost
127.0.0.11 bedrock-runtime.us-east-1.amazonaws.com
127.0.0.12 codeload.github.com
127.0.0.13 api.osv.dev
HOSTS
socat TCP-LISTEN:443,bind=127.0.0.11,fork,reuseaddr VSOCK-CONNECT:3:8001 &
socat TCP-LISTEN:443,bind=127.0.0.12,fork,reuseaddr VSOCK-CONNECT:3:8002 &
socat TCP-LISTEN:443,bind=127.0.0.13,fork,reuseaddr VSOCK-CONNECT:3:8003 &
# Inbound chat traffic arrives from the host over vsock.
socat VSOCK-LISTEN:8787,fork,reuseaddr TCP:127.0.0.1:8787 &
exec python3 /enclave/bootstrap.py
