# Doorman relay: approving rotations from a phone

Status: built. The relay is `apps/relay` (AWS Lambda + DynamoDB, URL in `RELAY.url`), the phone app
is `apps/mobile`, and the shared crypto is `packages/pairing`. The first version pairs by QR code
instead of WebAuthn: same guarantees, no hosted gateway account needed. See "As built" below; the
original design follows it.

## As built

```
CLI                                   Relay (opaque mailbox)                 Phone app
───                                   ──────────────────────                 ─────────
sikrets pair: QR {relay, X25519 pub, pairing secret} ─────── camera ───────▶ X25519 + Ed25519 keys
                                      box to-cli ◀── hello (sealed with secret)
approvals watch: snapshot ──sealed──▶ box to-phone ──────────────────────▶  list, detail
                                      box to-cli ◀── Ed25519-signed decision ─ Face ID → sign
verify signature + one-time challenge, then rotate
```

- Box ids and the pairing id are HKDF outputs of the pairing secret. The relay never sees a key,
  a name, a reason or a decision: only box ids and XChaCha20-Poly1305 ciphertext with a TTL.
- Session key: `HKDF(X25519(cli, phone), salt = pairing secret)`; associated data binds direction.
- Each open request gets a 128-bit challenge, stored only in the project's `.sikrets/relay.json`.
  The phone signs `[context, version, pairing id, request id, resource, decision, challenge, time]`.
  The CLI verifies against the phone key it paired with, deletes the challenge, then decides. A
  replay, a decision for another request or pairing, a forged or flipped signature, or one older
  than 15 minutes is refused.
- The phone's signing key is a keychain item that requires Face ID in standalone builds; in Expo
  Go it is device-only and gated by `expo-local-authentication`.
- No push yet: the app polls while open. APNs needs a paid Apple Developer account.


On the laptop, `sikrets approvals` asks with Touch ID or a dialog. When the person is away from the
laptop, the request has to reach their phone. The CLI can't push to a phone directly, so our hosted
gateway relays it.

## Flow

```
CLI (laptop/CI)            Gateway (sikrets.usetennant.com)          Phone
───────────────            ─────────────────────────────────          ─────
pending request ──POST──▶  store {id, reason, resource, expiry}
                           mint one-time link ──── push/email ─────▶  open link
                                                                      passkey prompt (Face ID)
                           verify assertion  ◀──── signed approve ──  approve / deny
CLI polls/long-polls ◀──   decision + signature
verify signature, then run `sikrets rotate`
```

## What the gateway sees

- Request id, resource name, a generic reason category (`exposed`, `expired`, `requested`) and the
  expiry. Never a secret, never the detection source, never the data key.
- Notifications use the same generic wording as the laptop, e.g. "We think this key may be
  exposed". The phone never learns where a detection came from.

## One-time links

- The link carries a random 128-bit token, stored hashed on the gateway, bound to one request id.
- Single use and short-lived (matches `APPROVAL_TTL`, 24h at most; 15 minutes is the target).
- Opening the link does nothing on its own. It only shows the request and starts the passkey
  ceremony, so link previews and scanners can't approve anything.

## Approval acts like a passkey

- During `sikrets approvals pair`, the phone registers a WebAuthn passkey with the gateway and the
  CLI records its public key locally.
- The approval is a WebAuthn assertion whose challenge is `H(request id ‖ decision ‖ expiry)`.
  The gateway relays the assertion unchanged.
- The CLI verifies the assertion against the paired public key itself. A compromised gateway can
  delay or drop a request, but it can't forge an approval or turn a deny into an approve.

## Failure modes

- Gateway down or phone offline: the request stays pending and the laptop prompt still works.
- Expired link or request: the decision is refused; triggers file a new request.
- Replay: the challenge binds the request id and the CLI marks the request decided on first use.

## Out of scope for the first version

Multiple approvers, quorum approvals for teams, and approving from a watch.
