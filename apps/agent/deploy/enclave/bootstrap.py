"""Runs inside the enclave. Waits for the host to send short-lived AWS credentials and the access
code over vsock, starts the agent, keeps the credentials fresh, and publishes an attestation
document signed by the Nitro Security Module so anyone can check which image is running."""
import base64, ctypes, datetime, fcntl, json, os, socket, subprocess, threading, time
import cbor2

CREDS = "/run/creds.json"
ATTESTATION = "/run/attestation.json"
NSM_IOCTL = 0xC0200A00  # _IOWR(0x0A, 0, struct nsm_message)


class IoVec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


class NsmMessage(ctypes.Structure):
    _fields_ = [("request", IoVec), ("response", IoVec)]


def attest(nonce: bytes) -> dict:
    req = cbor2.dumps({"Attestation": {"user_data": None, "nonce": nonce, "public_key": None}})
    rbuf = ctypes.create_string_buffer(req, len(req))
    obuf = ctypes.create_string_buffer(0x3000)
    msg = NsmMessage(IoVec(ctypes.addressof(rbuf), len(req)), IoVec(ctypes.addressof(obuf), 0x3000))
    fd = os.open("/dev/nsm", os.O_RDWR)
    try:
        fcntl.ioctl(fd, NSM_IOCTL, msg)
    finally:
        os.close(fd)
    resp = cbor2.loads(obuf.raw[: msg.response.len])
    doc = resp["Attestation"]["document"]
    cose = cbor2.loads(doc)
    cose = cose.value if hasattr(cose, "value") else cose
    payload = cbor2.loads(cose[2])
    pcrs = {str(k): v.hex() for k, v in sorted(payload["pcrs"].items()) if k in (0, 1, 2, 3, 4, 8)}
    return {
        "enclave": True,
        "moduleId": payload.get("module_id"),
        "digest": payload.get("digest"),
        "timestamp": datetime.datetime.fromtimestamp(payload["timestamp"] / 1000, datetime.timezone.utc).isoformat(),
        "pcrs": pcrs,
        "nonce": nonce.hex(),
        "document": base64.b64encode(doc).decode(),
        "verify": "The document is a COSE_Sign1 signed by the AWS Nitro Attestation PKI (root: https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip). PCR0-2 must match the measurements published for this build.",
    }


def write(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def refresh_attestation() -> None:
    while True:
        try:
            write(ATTESTATION, attest(os.urandom(32)))
        except Exception as e:  # noqa: BLE001
            write(ATTESTATION, {"enclave": True, "error": f"attestation failed: {e}"})
        time.sleep(600)


def main() -> None:
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, 9000))
    server.listen(4)
    agent = None
    while True:
        conn, _ = server.accept()
        with conn:
            data = b""
            while chunk := conn.recv(65536):
                data += chunk
        try:
            msg = json.loads(data)
        except ValueError:
            continue
        write(CREDS, msg["credentials"])
        if agent is None or agent.poll() is not None:
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": "/tmp",
                "HOST": "127.0.0.1",
                "PORT": "8787",
                "BEDROCK_REGION": "us-east-1",
                "AWS_CREDENTIALS_FILE": CREDS,
                "ATTESTATION_FILE": ATTESTATION,
                "ACCESS_CODE": msg["accessCode"],
            }
            if agent is None:
                threading.Thread(target=refresh_attestation, daemon=True).start()
            agent = subprocess.Popen(["/usr/local/bin/bun", "src/server.ts"], cwd="/app", env=env)


if __name__ == "__main__":
    main()
