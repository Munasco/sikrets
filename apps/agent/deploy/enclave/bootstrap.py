"""Runs inside the enclave. Waits for the host to send the access code and the model API key's KMS
ciphertext over vsock, decrypts the key itself, starts the agent (the gateway, which runs opencode)
and keeps it running, and publishes an attestation document signed by the Nitro Security Module so
anyone can check which image is running.

The model key is decrypted with KMS's attested flow: the enclave sends KMS an attestation document
that carries a fresh public key, KMS checks the document's PCR0 against the key policy and returns
the plaintext encrypted to that public key. The host relays the call (TLS end to end) and hands over
temporary AWS credentials, but only ever sees ciphertext. The host re-sends everything every 15
minutes; a changed value restarts the agent.

TLS ends in here too. The enclave makes its own TLS key and gets a certificate for the hostname
baked into the image (/enclave/tls-host) from Let's Encrypt, answering the HTTP-01 challenge on the
port-80 path the host relays. The key leaves the enclave only encrypted under a data key from KMS
GenerateDataKey, which the key policy allows only with this image's attestation: the host keeps that
blob and the (public) certificate and hands them back on restart, and can't read either key."""
import base64, ctypes, datetime, fcntl, hashlib, hmac, http.client, http.server, json, os, socket, ssl, subprocess, threading, time, urllib.parse
import cbor2
from asn1crypto import cms
from cryptography import x509
from cryptography.hazmat.primitives import hashes, padding as sympadding, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.x509.oid import NameOID

ATTESTATION = "/run/attestation.json"
# The access code, for the gateway to re-read when it changes (no restart), and the key's and the
# certificate's state, for its /healthz.
ACCESS_CODE_FILE = "/run/access-code"
HEALTH = "/run/health.json"
NSM_IOCTL = 0xC0200A00  # _IOWR(0x0A, 0, struct nsm_message)
# Must match the context deploy/aws.sh encrypted the key with.
KEY_CONTEXT = {"app": "sikrets-agent-demo", "secret": "model-key"}
KEY_ALIAS = "alias/sikrets-agent-demo"
TLS_CONTEXT = {"app": "sikrets-agent-demo", "secret": "tls-key"}
TLS_DIR = "/run/tls"
TLS_HOST_FILE = "/enclave/tls-host"
ACME_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory"
CHALLENGE_PORT = 8080
# Renew when the certificate has less than this left (Let's Encrypt issues 90 days).
RENEW_DAYS = 30
# After a failed pass, wait this long, doubling per failure up to the cap: Let's Encrypt allows 5
# failed validations an hour and 5 duplicate certificates a week.
TLS_RETRY = 300
TLS_RETRY_MAX = 6 * 3600


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


def kms_attested(target: str, body: dict, creds: dict, region: str, now: datetime.datetime) -> tuple:
    """A KMS call whose plaintext comes back encrypted to a fresh key of this enclave, with an
    attestation document KMS checks against the key policy's PCR0. Returns (plaintext, response)."""
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    doc = nsm_document(os.urandom(32), public)
    res = kms(creds, region, target, {**body, "Recipient": {"KeyEncryptionAlgorithm": "RSAES_OAEP_SHA_256", "AttestationDocument": base64.b64encode(doc).decode()}}, now)
    if "Plaintext" in res:
        raise RuntimeError("KMS returned plaintext; refusing it")
    return unwrap(res["CiphertextForRecipient"], private), res


def decrypt_model_key(ciphertext: str, creds: dict, region: str, now: datetime.datetime) -> str:
    """Decrypts the model key through KMS, attested: only this enclave image can, and only it can
    read the answer."""
    plain, _ = kms_attested("TrentService.Decrypt", {"CiphertextBlob": ciphertext, "EncryptionContext": KEY_CONTEXT}, creds, region, now)
    return plain.decode()


def unwrap(ciphertext_for_recipient: str, private) -> bytes:
    """KMS's answer for a recipient: CMS EnvelopedData, an AES key wrapped with RSA-OAEP to our key."""
    env = cms.ContentInfo.load(base64.b64decode(ciphertext_for_recipient))["content"]
    wrapped = env["recipient_infos"][0].chosen["encrypted_key"].native
    cek = private.decrypt(wrapped, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    info = env["encrypted_content_info"]
    alg = info["content_encryption_algorithm"]
    if alg["algorithm"].native != "aes256_cbc":
        raise RuntimeError(f"unexpected content cipher {alg['algorithm'].native}")
    dec = Cipher(algorithms.AES(cek), modes.CBC(alg["parameters"].native)).decryptor()
    padded = dec.update(info["encrypted_content"].native) + dec.finalize()
    unpad = sympadding.PKCS7(128).unpadder()
    return unpad.update(padded) + unpad.finalize()


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class Acme:
    """Just enough of an ACME (RFC 8555) client for one HTTP-01 certificate from Let's Encrypt."""

    def __init__(self) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        n = self.key.public_key().public_numbers()
        self.jwk = {"crv": "P-256", "kty": "EC", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))}
        self.thumbprint = b64u(hashlib.sha256(json.dumps(self.jwk, sort_keys=True, separators=(",", ":")).encode()).digest())
        self.kid = None
        self.nonce = None
        self.dir = json.loads(self.http("GET", ACME_DIRECTORY)[2])

    def http(self, method: str, url: str, body: str = None, headers: dict = None) -> tuple:
        u = urllib.parse.urlsplit(url)
        conn = http.client.HTTPSConnection(u.hostname, 443, timeout=30, context=ssl.create_default_context())
        try:
            conn.request(method, u.path + (f"?{u.query}" if u.query else ""), body=body, headers=headers or {})
            res = conn.getresponse()
            data = res.read()
        finally:
            conn.close()
        if res.getheader("Replay-Nonce"):
            self.nonce = res.getheader("Replay-Nonce")
        return res.status, res, data

    def post(self, url: str, payload) -> tuple:
        """A signed POST; payload None is POST-as-GET."""
        for _ in range(3):
            if not self.nonce:
                self.http("HEAD", self.dir["newNonce"])
            protected = {"alg": "ES256", "nonce": self.nonce, "url": url, **({"kid": self.kid} if self.kid else {"jwk": self.jwk})}
            self.nonce = None
            p = b64u(json.dumps(protected).encode())
            pl = "" if payload is None else b64u(json.dumps(payload).encode())
            r, s_ = decode_dss_signature(self.key.sign(f"{p}.{pl}".encode(), ec.ECDSA(hashes.SHA256())))
            body = json.dumps({"protected": p, "payload": pl, "signature": b64u(r.to_bytes(32, "big") + s_.to_bytes(32, "big"))})
            status, res, data = self.http("POST", url, body, {"Content-Type": "application/jose+json"})
            if status == 400 and b"badNonce" in data:
                continue
            if status >= 400:
                raise RuntimeError(f"ACME {status}: {data[:300].decode(errors='replace')}")
            return res, data
        raise RuntimeError("ACME: no usable nonce")

    def poll(self, url: str, done: str) -> dict:
        for _ in range(60):
            obj = json.loads(self.post(url, None)[1])
            if obj["status"] == done:
                return obj
            if obj["status"] == "invalid":
                raise RuntimeError(f"ACME: {url} is invalid: {json.dumps(obj)[:300]}")
            time.sleep(2)
        raise RuntimeError(f"ACME: timed out waiting for {url}")

    def certificate(self, host: str, key, challenges: dict) -> str:
        res, _ = self.post(self.dir["newAccount"], {"termsOfServiceAgreed": True})
        self.kid = res.getheader("Location")
        res, data = self.post(self.dir["newOrder"], {"identifiers": [{"type": "dns", "value": host}]})
        order_url, order = res.getheader("Location"), json.loads(data)
        for authz_url in order["authorizations"]:
            authz = json.loads(self.post(authz_url, None)[1])
            if authz["status"] == "valid":
                continue
            ch = next(c for c in authz["challenges"] if c["type"] == "http-01")
            challenges[ch["token"]] = f"{ch['token']}.{self.thumbprint}"
            self.post(ch["url"], {})
            self.poll(authz_url, "valid")
        csr = (x509.CertificateSigningRequestBuilder()
               .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
               .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
               .sign(key, hashes.SHA256()))
        self.post(order["finalize"], {"csr": b64u(csr.public_bytes(serialization.Encoding.DER))})
        order = self.poll(order_url, "valid")
        return self.post(order["certificate"], None)[1].decode()


def serve_challenges(challenges: dict, host: str) -> None:
    """The port-80 path: HTTP-01 answers, and a redirect to HTTPS for everything else."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            prefix = "/.well-known/acme-challenge/"
            if self.path.startswith(prefix) and self.path[len(prefix):] in challenges:
                body = challenges[self.path[len(prefix):]].encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
            else:
                body = b""
                self.send_response(301)
                self.send_header("Location", f"https://{host}{self.path}")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_HEAD = do_GET

        def log_message(self, *args):  # no request logs
            pass

    http.server.ThreadingHTTPServer(("127.0.0.1", CHALLENGE_PORT), Handler).serve_forever()


def cert_ok(cert_pem: str, key, host: str, now: datetime.datetime) -> bool:
    """The certificate is for this host and key and has more than RENEW_DAYS left."""
    try:
        cert = x509.load_pem_x509_certificates(cert_pem.encode())[0]
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
        same_key = cert.public_key().public_numbers() == key.public_key().public_numbers()
        return host in names and same_key and cert.not_valid_after_utc - now > datetime.timedelta(days=RENEW_DAYS)
    except Exception:  # noqa: BLE001
        return False


def seal_tls_key(key, creds: dict, region: str, now: datetime.datetime) -> dict:
    """The TLS key, encrypted under a fresh KMS data key that only this image can get back."""
    data_key, res = kms_attested("TrentService.GenerateDataKey", {"KeyId": KEY_ALIAS, "KeySpec": "AES_256", "EncryptionContext": TLS_CONTEXT}, creds, region, now)
    nonce = os.urandom(12)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return {"dataKey": res["CiphertextBlob"], "nonce": b64u(nonce), "key": b64u(AESGCM(data_key).encrypt(nonce, pem, b"tls-key"))}


class TlsBlobDamaged(Exception):
    """The stored TLS key blob can never open: not ours, or corrupt. A transport error or a KMS
    refusal (say, an unpinned PCR0) is not this: those are retried with the same blob."""


def open_tls_key(blob: dict, creds: dict, region: str, now: datetime.datetime):
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    try:
        nonce, sealed, data_key_ct = base64.urlsafe_b64decode(pad(blob["nonce"])), base64.urlsafe_b64decode(pad(blob["key"])), blob["dataKey"]
    except (KeyError, TypeError, ValueError) as e:
        raise TlsBlobDamaged(f"malformed: {type(e).__name__}") from e
    try:
        data_key, _ = kms_attested("TrentService.Decrypt", {"CiphertextBlob": data_key_ct, "EncryptionContext": TLS_CONTEXT}, creds, region, now)
    except RuntimeError as e:
        if "InvalidCiphertextException" in str(e):
            raise TlsBlobDamaged("KMS can't read its data key") from e
        raise
    try:
        pem = AESGCM(data_key).decrypt(nonce, sealed, b"tls-key")
        return serialization.load_pem_private_key(pem, None)
    except (InvalidTag, ValueError) as e:
        raise TlsBlobDamaged(f"doesn't decrypt: {type(e).__name__}") from e


def install_tls(key, cert_pem: str, state: dict) -> None:
    os.makedirs(TLS_DIR, mode=0o700, exist_ok=True)
    for name, data in (("key.pem", key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()), ("cert.pem", cert_pem)):
        tmp = os.path.join(TLS_DIR, name + ".tmp")
        with open(tmp, "w") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, os.path.join(TLS_DIR, name))
    state["tls_version"] = state.get("tls_version", 0) + 1


# The TLS manager's states (state["tls"]): "starting" until the host's first message, "off" when the
# image has no hostname, "issuing" while Let's Encrypt is asked, "sealing" while KMS seals the key,
# "ok", or "error: ..." (retried with backoff). The issued certificate is kept across a failed
# seal, so a retry only seals again: it never orders a duplicate certificate.
def tls_step(state: dict, tls: dict, host: str, challenges: dict) -> None:
    """One pass of the TLS manager. `tls` is its own memory across passes: the key, the installed
    certificate, and the sealed blob of that key once KMS has made one. Raises on failure."""
    msg = state["msg"]
    creds, region = msg["credentials"], msg["region"]
    now = datetime.datetime.fromtimestamp(msg["now"], datetime.timezone.utc) + datetime.timedelta(seconds=time.monotonic() - state["msg_at"])
    stored = msg.get("tls") or {}
    # The host's copy, opened once. A damaged blob is set aside for good; any other failure
    # (network, KMS refusing an unpinned PCR0) leaves it to try again on the next pass.
    if tls.get("key") is None and stored.get("keyBlob") and stored.get("keyBlob") != tls.get("bad_blob"):
        try:
            tls["key"] = open_tls_key(stored["keyBlob"], creds, region, now)
            tls["sealed"] = stored["keyBlob"]
        except TlsBlobDamaged:
            tls["bad_blob"] = stored["keyBlob"]
        if tls.get("key") is not None and cert_ok(stored.get("cert", ""), tls["key"], host, now):
            install_tls(tls["key"], stored["cert"], state)
            tls["cert"] = stored["cert"]
    if not tls.get("cert") or not cert_ok(tls["cert"], tls.get("key"), host, now):
        if tls.get("key") is None:
            tls["key"] = ec.generate_private_key(ec.SECP256R1())
            tls["sealed"] = None
        state["tls"] = "issuing"
        cert = Acme().certificate(host, tls["key"], challenges)
        install_tls(tls["key"], cert, state)
        tls["cert"] = cert
    if not tls.get("sealed"):
        state["tls"] = "sealing"
        tls["sealed"] = seal_tls_key(tls["key"], creds, region, now)
    state["tls_store"] = {"keyBlob": tls["sealed"], "cert": tls["cert"]}
    state["tls"] = "ok"


def manage_tls(state: dict, sleep=time.sleep) -> None:
    """Keeps a valid certificate installed: the stored one if it's still good, else a new one."""
    host = open(TLS_HOST_FILE).read().strip() if os.path.exists(TLS_HOST_FILE) else ""
    if not host:
        state["tls"] = "off"
        return
    challenges: dict = {}
    threading.Thread(target=serve_challenges, args=(challenges, host), daemon=True).start()
    tls: dict = {}
    failures = 0
    while True:
        if not state.get("msg"):
            sleep(5)
            continue
        try:
            tls_step(state, tls, host, challenges)
            failures, wait = 0, 600
        except Exception as e:  # noqa: BLE001
            failures += 1
            state["tls"] = f"error: {type(e).__name__}: {e}"[:300]
            wait = min(TLS_RETRY * 2 ** (failures - 1), TLS_RETRY_MAX)
        sleep(wait)


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
    """Keeps the agent running with the latest values; restarts it when it exits or the model key
    or the certificate changes. A new access code doesn't restart it: the gateway re-reads the
    file, so a rotation signs everyone out without stopping their chats."""
    agent = None
    running = None
    health = None
    while True:
        now_health = {"modelKey": state.get("model_key", "waiting"), "tls": state.get("tls", "starting")}
        if now_health != health:
            write(HEALTH, now_health)
            health = now_health
        wanted = (state.get("key"), state.get("tls_version", 0)) if state.get("key") and state.get("access_code_ready") else None
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
                "AGENT_HOME": "/run/sikrets",
                "ATTESTATION_FILE": ATTESTATION,
                "ACCESS_CODE_FILE": ACCESS_CODE_FILE,
                "HEALTH_FILE": HEALTH,
                "MODEL_API_KEY": wanted[0],
                "TLS_CERT_FILE": os.path.join(TLS_DIR, "cert.pem"),
                "TLS_KEY_FILE": os.path.join(TLS_DIR, "key.pem"),
            }
            agent = subprocess.Popen(["/usr/local/bin/bun", "src/server.ts"], cwd="/app", env=env)
            running = wanted
        time.sleep(2)


def write_text(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def receive(msg: dict, state: dict) -> dict:
    """Handles one message from the host: decrypts the model key when its ciphertext is new, and
    answers with a status the host can log. Never includes a secret.
    modelKey is "ok", "stale" (a new ciphertext didn't decrypt; the last good key keeps serving)
    or "error" (no key at all)."""
    # The TLS manager reads the latest credentials, clock and stored certificate from here.
    state["msg_at"] = time.monotonic()
    state["msg"] = msg
    code = str(msg.get("accessCode") or "").strip()
    # An empty code would open the gateway to everyone: never start (or keep feeding) it with one.
    if not code:
        raise RuntimeError("the access code is empty; the agent stays down until it's set")
    if state.get("access_code") != code:
        write_text(ACCESS_CODE_FILE, code)
        state["access_code"] = code
        state["access_code_ready"] = True
    ciphertext = msg["modelKeyCiphertext"]
    reply = {}
    if state.get("ciphertext") != ciphertext:
        now = datetime.datetime.fromtimestamp(msg["now"], datetime.timezone.utc) if msg.get("now") else datetime.datetime.now(datetime.timezone.utc)
        try:
            state["key"] = decrypt_model_key(ciphertext, msg["credentials"], msg["region"], now)
            state["ciphertext"] = ciphertext
            state["model_key"] = "ok"
        except Exception as e:  # noqa: BLE001
            # A key that fails to decrypt leaves the last good one running, and says so.
            state["model_key"] = "stale" if "key" in state else "error"
            reply["reason"] = f"{type(e).__name__}: {e}"[:300]
    reply["modelKey"] = state.get("model_key", "error")
    reply["tls"] = state.get("tls", "starting")
    # A newly sealed key and certificate, for the host to keep (both useless to it).
    if state.get("tls_store") and state.get("tls_store") != (msg.get("tls") or {}):
        reply["tlsStore"] = state["tls_store"]
    return reply


def main() -> None:
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, 9000))
    server.listen(4)
    state: dict = {}
    threading.Thread(target=refresh_attestation, daemon=True).start()
    threading.Thread(target=supervise, args=(state,), daemon=True).start()
    threading.Thread(target=manage_tls, args=(state,), daemon=True).start()
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
