# The agent's enclave image. Built on the host (arm64) and converted to an EIF by nitro-cli; its
# measurements (PCR0-2) identify exactly this image.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023
RUN dnf install -y socat iproute python3 python3-pip ca-certificates && pip3 install --no-cache-dir cbor2==5.6.5 && dnf clean all
COPY bun /usr/local/bin/bun
COPY app /app
COPY run.sh bootstrap.py /enclave/
WORKDIR /app
CMD ["/bin/sh", "/enclave/run.sh"]
