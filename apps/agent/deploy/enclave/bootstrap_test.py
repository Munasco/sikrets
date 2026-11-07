"""Tests for bootstrap.py's TLS manager and host-message handling, with KMS, ACME and the NSM
stubbed out. Needs the image's Python packages (cbor2, cryptography, asn1crypto):
    python3 -m unittest deploy/enclave/bootstrap_test.py"""
import os, sys, tempfile, time, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bootstrap  # noqa: E402

HOST = "agent.example.test"


class Fakes:
    """Stand-ins for the network: counts ACME orders and seals, and fails them on request."""

    def __init__(self, test: unittest.TestCase):
        self.orders = 0
        self.seals = 0
        self.opens = 0
        self.seal_error = None
        self.open_error = None
        self.installed = []
        fakes = self

        class Acme:
            def certificate(self, host, key, challenges):
                fakes.orders += 1
                return f"cert-{fakes.orders}"

        def seal(key, creds, region, now):
            fakes.seals += 1
            if fakes.seal_error:
                raise fakes.seal_error
            return {"blob": fakes.seals}

        def open_key(blob, creds, region, now):
            fakes.opens += 1
            if fakes.open_error:
                raise fakes.open_error
            return "stored-key"

        def install(key, cert, state):
            fakes.installed.append(cert)
            state["tls_version"] = state.get("tls_version", 0) + 1

        patches = {
            "Acme": Acme,
            "seal_tls_key": seal,
            "open_tls_key": open_key,
            "install_tls": install,
            "cert_ok": lambda cert, key, host, now: bool(cert) and key is not None,
            "ec": type("ec", (), {"generate_private_key": staticmethod(lambda curve: "new-key"), "SECP256R1": staticmethod(lambda: None)}),
        }
        for name, value in patches.items():
            original = getattr(bootstrap, name)
            setattr(bootstrap, name, value)
            test.addCleanup(setattr, bootstrap, name, original)


def message(tls=None):
    return {"credentials": {}, "region": "us-east-1", "now": time.time(), "tls": tls, "accessCode": "code", "modelKeyCiphertext": "ct"}


def fresh_state(tls=None):
    return {"msg": message(tls), "msg_at": time.monotonic()}


class TlsStep(unittest.TestCase):
    def test_a_failed_seal_is_retried_without_ordering_another_certificate(self):
        f = Fakes(self)
        state, mem = fresh_state(), {}
        f.seal_error = RuntimeError("KMS 400 AccessDeniedException: PCR0 not pinned")
        with self.assertRaises(RuntimeError):
            bootstrap.tls_step(state, mem, HOST, {})
        self.assertEqual(f.orders, 1)
        self.assertEqual(state["tls"], "sealing")
        # The next passes only seal again, until KMS allows it.
        with self.assertRaises(RuntimeError):
            bootstrap.tls_step(state, mem, HOST, {})
        f.seal_error = None
        bootstrap.tls_step(state, mem, HOST, {})
        self.assertEqual(f.orders, 1)
        self.assertEqual(f.seals, 3)
        self.assertEqual(state["tls"], "ok")
        self.assertEqual(state["tls_store"], {"keyBlob": {"blob": 3}, "cert": "cert-1"})
        # One certificate installed, so the agent restarted once for it.
        self.assertEqual(state["tls_version"], 1)

    def test_a_transient_error_opening_the_stored_key_is_retried_not_replaced(self):
        f = Fakes(self)
        stored = {"keyBlob": {"blob": "host"}, "cert": "stored-cert"}
        state, mem = fresh_state(stored), {}
        f.open_error = RuntimeError("KMS 503 ServiceUnavailable")
        with self.assertRaises(RuntimeError):
            bootstrap.tls_step(state, mem, HOST, {})
        self.assertNotIn("bad_blob", mem)
        f.open_error = None
        bootstrap.tls_step(state, mem, HOST, {})
        self.assertEqual(f.orders, 0)
        self.assertEqual(f.seals, 0)
        self.assertEqual(f.installed, ["stored-cert"])
        self.assertEqual(state["tls_store"], stored)
        self.assertEqual(state["tls"], "ok")

    def test_a_damaged_stored_key_is_replaced_once(self):
        f = Fakes(self)
        stored = {"keyBlob": {"blob": "garbage"}, "cert": "stored-cert"}
        state, mem = fresh_state(stored), {}
        f.open_error = bootstrap.TlsBlobDamaged("doesn't decrypt")
        bootstrap.tls_step(state, mem, HOST, {})
        self.assertEqual((f.orders, f.seals), (1, 1))
        # The host still sends the damaged blob until it saves the new one: not tried again.
        bootstrap.tls_step(state, mem, HOST, {})
        self.assertEqual((f.orders, f.seals, f.opens), (1, 1, 1))


class ManageTls(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        host_file = os.path.join(d, "tls-host")
        with open(host_file, "w") as fh:
            fh.write(HOST)
        for name, value in {"TLS_HOST_FILE": host_file, "serve_challenges": lambda c, h: None}.items():
            original = getattr(bootstrap, name)
            setattr(bootstrap, name, value)
            self.addCleanup(setattr, bootstrap, name, original)

    def run_passes(self, step, passes):
        original = bootstrap.tls_step
        bootstrap.tls_step = step
        self.addCleanup(setattr, bootstrap, "tls_step", original)
        waits = []

        def sleep(s):
            waits.append(s)
            if len(waits) >= passes:
                raise KeyboardInterrupt

        state = fresh_state()
        with self.assertRaises(KeyboardInterrupt):
            bootstrap.manage_tls(state, sleep=sleep)
        return state, waits

    def test_failures_back_off_exponentially_up_to_the_cap(self):
        def fail(state, mem, host, challenges):
            raise RuntimeError("ACME 429")

        state, waits = self.run_passes(fail, 9)
        self.assertEqual(waits[:4], [300, 600, 1200, 2400])
        self.assertEqual(waits[-1], bootstrap.TLS_RETRY_MAX)
        self.assertTrue(state["tls"].startswith("error: RuntimeError: ACME 429"))

    def test_no_hostname_means_tls_is_off_not_starting(self):
        with open(bootstrap.TLS_HOST_FILE, "w") as fh:
            fh.write("")
        state = {}
        bootstrap.manage_tls(state)
        self.assertEqual(state["tls"], "off")


class Receive(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        self.code_file = os.path.join(d, "access-code")
        original = bootstrap.ACCESS_CODE_FILE
        bootstrap.ACCESS_CODE_FILE = self.code_file
        self.addCleanup(setattr, bootstrap, "ACCESS_CODE_FILE", original)
        self.decrypt_error = None
        original_decrypt = bootstrap.decrypt_model_key

        def decrypt(ciphertext, creds, region, now):
            if self.decrypt_error:
                raise self.decrypt_error
            return f"key-for-{ciphertext}"

        bootstrap.decrypt_model_key = decrypt
        self.addCleanup(setattr, bootstrap, "decrypt_model_key", original_decrypt)

    def test_an_empty_access_code_never_reaches_the_agent(self):
        state = {}
        with self.assertRaises(RuntimeError):
            bootstrap.receive({**message(), "accessCode": "  "}, state)
        self.assertFalse(os.path.exists(self.code_file))
        self.assertNotIn("access_code_ready", state)

    def test_the_access_code_goes_to_a_file_not_the_agent_restart_tuple(self):
        state = {}
        self.assertEqual(bootstrap.receive(message(), state)["modelKey"], "ok")
        with open(self.code_file) as fh:
            self.assertEqual(fh.read(), "code")
        bootstrap.receive({**message(), "accessCode": "rotated"}, state)
        with open(self.code_file) as fh:
            self.assertEqual(fh.read(), "rotated")
        self.assertEqual(state["key"], "key-for-ct")

    def test_a_new_key_that_fails_to_decrypt_is_reported_stale_while_the_old_one_serves(self):
        state = {}
        bootstrap.receive(message(), state)
        self.decrypt_error = RuntimeError("KMS 400 AccessDeniedException")
        reply = bootstrap.receive({**message(), "modelKeyCiphertext": "ct2"}, state)
        self.assertEqual(reply["modelKey"], "stale")
        self.assertIn("AccessDenied", reply["reason"])
        self.assertEqual(state["key"], "key-for-ct")

    def test_no_key_at_all_is_an_error(self):
        self.decrypt_error = RuntimeError("KMS 400 AccessDeniedException")
        self.assertEqual(bootstrap.receive(message(), {})["modelKey"], "error")


if __name__ == "__main__":
    unittest.main()
