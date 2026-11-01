# The agent's enclave image: the gateway (Bun), opencode (the pinned linux-arm64 build from
# node_modules) and the enclave entrypoint. Built on the host (arm64) and converted to an EIF by
# nitro-cli; its measurements (PCR0-2) identify exactly this image.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023
# cbor2 reads the Nitro Security Module's answers; cryptography and asn1crypto unwrap the model key
# KMS encrypts to the enclave (bootstrap.py).
RUN dnf install -y socat iproute python3 python3-pip ca-certificates && pip3 install --no-cache-dir cbor2==5.6.5 cryptography==44.0.3 asn1crypto==1.5.1 && dnf clean all
COPY bun /usr/local/bin/bun
COPY app /app
COPY run.sh bootstrap.py hosts /enclave/
WORKDIR /app
CMD ["/bin/sh", "/enclave/run.sh"]
