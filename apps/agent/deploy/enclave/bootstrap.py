"""Runs inside the enclave. Waits for the host to send the access code and the model API key's KMS
ciphertext over vsock, decrypts the key itself, starts the agent (the gateway, which runs opencode)
and keeps it running, and publishes an attestation document signed by the Nitro Security Module so
anyone can check which image is running.

The model key is decrypted with KMS's attested flow: the enclave sends KMS an attestation document
that carries a fresh public key, KMS checks the document's PCR0 against the key policy and returns
the plaintext encrypted to that public key. The host relays the call (TLS end to end) and hands over
temporary AWS credentials, but only ever sees ciphertext. The host re-sends everything every 15
minutes; a changed value restarts the agent."""
import base64, ctypes, datetime, fcntl, hashlib, hmac, http.client, json, os, socket, ssl, subprocess, threading, time
import cbor2
from asn1crypto import cms
from cryptography.hazmat.primitives import hashes, padding as sympadding, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ATTESTATION = "/run/attestation.json"
NSM_IOCTL = 0xC0200A00  # _IOWR(0x0A, 0, struct nsm_message)
# Must match the context deploy/aws.sh encrypted the key with.
KEY_CONTEXT = {"app": "sikrets-agent-demo", "secret": "model-key"}


class IoVec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


class NsmMessage(ctypes.Structure):
    _fields_ = [("request", IoVec), ("response", IoVec)]


def nsm_document(nonce: bytes, public_key: bytes = None) -> bytes:
    """A COSE_Sign1 attestation document from the Nitro Security Module."""
    req = cbor2.dumps({"Attestation": {"user_data": None, "nonce": nonce, "public_key": public_key}})
    rbuf = ctypes.create_string_buffer(req, len(req))
    obuf = ctypes.create_string_buffer(0x3000)
    msg = NsmMessage(IoVec(ctypes.addressof(rbuf), len(req)), IoVec(ctypes.addressof(obuf), 0x3000))
    fd = os.open("/dev/nsm", os.O_RDWR)
    try:
        fcntl.ioctl(fd, NSM_IOCTL, msg)
    finally:
        os.close(fd)
    return cbor2.loads(obuf.raw[: msg.response.len])["Attestation"]["document"]


def attest(nonce: bytes) -> dict:
    doc = nsm_document(nonce)
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


def kms(creds: dict, region: str, target: str, body: dict, now: datetime.datetime) -> dict:
    """One KMS API call, signed with SigV4. The host's clock is used for the signature: an enclave's
    clock can drift, and a wrong time only makes the call fail."""
    host = f"kms.{region}.amazonaws.com"
    payload = json.dumps(body).encode()
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    headers = {"content-type": "application/x-amz-json-1.1", "host": host, "x-amz-date": stamp, "x-amz-target": target}
    if creds.get("Token"):
        headers["x-amz-security-token"] = creds["Token"]
    names = ";".join(sorted(headers))
    canonical = "\n".join(["POST", "/", "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), names, hashlib.sha256(payload).hexdigest()])
    scope = f"{stamp[:8]}/{region}/kms/aws4_request"
    key = ("AWS4" + creds["SecretAccessKey"]).encode()
    for part in (stamp[:8], region, "kms", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()]).encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={creds['AccessKeyId']}/{scope}, SignedHeaders={names}, Signature={signature}"
    conn = http.client.HTTPSConnection(host, 443, timeout=30, context=ssl.create_default_context())
    try:
        conn.request("POST", "/", body=payload, headers=headers)
        res = conn.getresponse()
        data = json.loads(res.read() or b"{}")
    finally:
        conn.close()
    if res.status != 200:
        raise RuntimeError(f"KMS {res.status} {data.get('__type', '')}: {data.get('message') or data.get('Message', '')}")
    return data


def decrypt_model_key(ciphertext: str, creds: dict, region: str, now: datetime.datetime) -> str:
    """Decrypts the model key through KMS, attested: only this enclave image can, and only it can
    read the answer. KMS returns CMS EnvelopedData: an AES key wrapped with RSA-OAEP to our key."""
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    doc = nsm_document(os.urandom(32), public)
    res = kms(creds, region, "TrentService.Decrypt", {
        "CiphertextBlob": ciphertext,
        "EncryptionContext": KEY_CONTEXT,
        "Recipient": {"KeyEncryptionAlgorithm": "RSAES_OAEP_SHA_256", "AttestationDocument": base64.b64encode(doc).decode()},
    }, now)
    if "Plaintext" in res:
        raise RuntimeError("KMS returned plaintext; refusing it")
    env = cms.ContentInfo.load(base64.b64decode(res["CiphertextForRecipient"]))["content"]
    wrapped = env["recipient_infos"][0].chosen["encrypted_key"].native
    cek = private.decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    info = env["encrypted_content_info"]
    alg = info["content_encryption_algorithm"]
    if alg["algorithm"].native != "aes256_cbc":
        raise RuntimeError(f"unexpected content cipher {alg['algorithm'].native}")
    dec = Cipher(algorithms.AES(cek), modes.CBC(alg["parameters"].native)).decryptor()
    padded = dec.update(info["encrypted_content"].native) + dec.finalize()
    unpad = sympadding.PKCS7(128).unpadder()
    return (unpad.update(padded) + unpad.finalize()).decode()


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


def supervise(state: dict) -> None:
    """Keeps the agent running with the latest values; restarts it when it exits or they change."""
    agent = None
    running = None
    while True:
        wanted = state.get("secrets")
        if wanted and (agent is None or agent.poll() is not None or wanted != running):
            if agent is not None and agent.poll() is None:
                agent.terminate()
                try:
                    agent.wait(10)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait()
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": "/tmp",
                "HOST": "127.0.0.1",
                "PORT": "8787",
                "OPENCODE_HOME": "/run/opencode",
                "ATTESTATION_FILE": ATTESTATION,
                "ACCESS_CODE": wanted[0],
                "MODEL_API_KEY": wanted[1],
            }
            agent = subprocess.Popen(["/usr/local/bin/bun", "src/server.ts"], cwd="/app", env=env)
            running = wanted
        time.sleep(2)


def receive(msg: dict, state: dict) -> dict:
    """Handles one message from the host: decrypts the model key when its ciphertext is new, and
    answers with a status the host can log. Never includes a secret."""
    ciphertext = msg["modelKeyCiphertext"]
    error = None
    if state.get("ciphertext") != ciphertext:
        now = datetime.datetime.fromtimestamp(msg["now"], datetime.timezone.utc) if msg.get("now") else datetime.datetime.now(datetime.timezone.utc)
        try:
            state["key"] = decrypt_model_key(ciphertext, msg["credentials"], msg["region"], now)
            state["ciphertext"] = ciphertext
        except Exception as e:  # noqa: BLE001
            error = e
    # A key that fails to decrypt leaves the last good one running.
    if "key" in state:
        state["secrets"] = (msg["accessCode"], state["key"])
    if error:
        raise error
    return {"modelKey": "ok"}


def main() -> None:
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, 9000))
    server.listen(4)
    state: dict = {}
    threading.Thread(target=refresh_attestation, daemon=True).start()
    threading.Thread(target=supervise, args=(state,), daemon=True).start()
    while True:
        conn, _ = server.accept()
        with conn:
            data = b""
            while chunk := conn.recv(65536):
                data += chunk
            try:
                reply = receive(json.loads(data), state)
            except Exception as e:  # noqa: BLE001
                reply = {"modelKey": "error", "reason": f"{type(e).__name__}: {e}"[:300]}
            try:
                conn.sendall(json.dumps(reply).encode())
            except OSError:
                pass


if __name__ == "__main__":
    main()
