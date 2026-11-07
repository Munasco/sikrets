# Doorman relay: approving rotations from a phone

Status: design only. Nothing here is built yet.

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
