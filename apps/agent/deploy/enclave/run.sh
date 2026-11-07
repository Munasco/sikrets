#!/bin/sh
# Enclave entrypoint. An enclave has no network, only vsock to its host. Loopback aliases stand in
# for the hosts the agent talks to (the model API, GitHub, OSV; listed in /enclave/hosts by
# host.sh); each is forwarded over vsock to a host-side vsock-proxy that only allows that one host.
# TLS runs end to end from inside the enclave, so the host relays encrypted bytes it can't read.
set -e
ip addr add 127.0.0.1/8 dev lo 2>/dev/null || true
ip link set dev lo up
echo "127.0.0.1 localhost" > /etc/hosts
while read -r ip host port; do
  echo "$ip $host" >> /etc/hosts
  socat TCP-LISTEN:443,bind=$ip,fork,reuseaddr VSOCK-CONNECT:3:$port &
done < /enclave/hosts
# Inbound chat traffic arrives from the host over vsock: plain HTTP from CloudFront's origin hop
# (8787), TLS straight from the load balancer, still encrypted, for the gateway's own HTTPS (8443),
# and the port-80 path for the certificate's HTTP-01 challenge (8080).
socat VSOCK-LISTEN:8787,fork,reuseaddr TCP:127.0.0.1:8787 &
socat VSOCK-LISTEN:8443,fork,reuseaddr TCP:127.0.0.1:8443 &
socat VSOCK-LISTEN:8080,fork,reuseaddr TCP:127.0.0.1:8080 &
exec python3 /enclave/bootstrap.py
