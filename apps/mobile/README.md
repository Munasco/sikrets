# Sikrets for iPhone

Approve or deny key rotations from your phone, see your key inventory (names and status, never
values), and open the security-agent chat. Expo (React Native, TypeScript).

Tabs: **Approvals** (list → detail → Approve / Deny), **Keys**, **Agent** (the hosted chat in a
web view), **Pair** (camera QR scan).

## How it stays zero-knowledge

- `sikrets pair` shows a QR code with the laptop's X25519 public key, a fresh 32-byte pairing
  secret and the relay URL. The phone makes its own X25519 + Ed25519 keys and sends its public keys
  back, sealed with a key derived from the pairing secret.
- Every message after that is XChaCha20-Poly1305 under `HKDF(X25519(laptop, phone), pairing secret)`.
  The relay (`apps/relay`) stores only ciphertext under box ids derived from the secret.
- Approving or denying signs `[request id, resource, decision, one-time challenge, time, pairing id]`
  with the phone's Ed25519 key. The CLI checks the signature against the key it paired with and the
  challenge it issued, consumes the challenge, and only then rotates. A relay can delay or drop a
  request; it can't approve one, replay one, or turn a deny into an approve.
- The signing key lives in the iOS keychain. In a standalone build the keychain item itself
  requires Face ID (`requireAuthentication`). Expo Go can't do that, so there the key is stored
  device-only and every use goes through `expo-local-authentication` first (in Expo Go iOS asks for
  the passcode instead of Face ID; a standalone build uses Face ID).
- Crypto is shared with the CLI: `packages/pairing`.

## Try it today with Expo Go (fastest, about 5 minutes)

You need: the laptop and iPhone on the same Wi-Fi, Bun, and **Expo Go** from the App Store.

1. On the laptop:
   ```sh
   cd apps/mobile
   bun install
   bunx expo start
   ```
   If the phone is on another network, use `bunx expo start --tunnel` instead.
2. On the iPhone, open the Camera app, scan the QR code Expo prints, and tap the banner. The app
   opens inside Expo Go.
3. In a project that has keys (`sikrets status` lists them), pair:
   ```sh
   sikrets pair
   ```
   In the app, open **Pair → Scan code** and point it at the terminal. The terminal says
   `Paired with iPhone`.
4. File a test request and send it to the phone:
   ```sh
   sikrets approvals request <resource> --reason requested --queue
   sikrets approvals watch
   ```
   Within a few seconds the request shows up under **Approvals** (and as a notification while the
   app is open).
5. Tap it, then **Approve with Face ID** (passcode in Expo Go) or **Deny**. `approvals watch`
   prints `apr_… : rotated from iPhone` (or `denied`) and the app shows the new status.

`sikrets approvals watch --once` sends and checks once, then exits. `sikrets pair --status` shows
the paired phone; `sikrets pair --forget` and **Pair → Unpair** undo it.

## Standalone app

### With a free Apple ID and Xcode (lasts 7 days)

1. `cd apps/mobile && bunx expo prebuild --platform ios` (creates `ios/`, not committed).
2. `open ios/Sikrets.xcworkspace`. In **Signing & Capabilities** pick your Personal Team and
   change the bundle id if Xcode says it's taken (e.g. `com.<you>.sikrets`).
3. Plug in the iPhone, select it as the run destination, and press Run. Use the **Release**
   scheme (Product → Scheme → Edit Scheme → Run → Build Configuration: Release) so the JS bundle is
   embedded and the app works without the dev server.
4. On the phone: Settings → General → VPN & Device Management → trust your Apple ID. Enable
   Developer Mode if iOS asks (Settings → Privacy & Security → Developer Mode).
5. Free provisioning expires after 7 days; run again from Xcode to renew.

Or in one step from the terminal with the phone plugged in: `bunx expo run:ios --device --configuration Release`.

### With EAS (needs a paid Apple Developer account for device installs)

```sh
cd apps/mobile
bunx eas-cli login
bunx eas-cli build:configure
bunx eas-cli device:create        # register the iPhone (opens a link on the phone)
bunx eas-cli build --platform ios --profile preview
```

Open the install link EAS prints on the phone.

## Notifications

The app polls the relay every 5 seconds while it's open and shows a local notification for each new
request. Real push (APNs) needs a paid Apple Developer account and a push service; it isn't wired
up yet, so requests only arrive while the app is in the foreground.

## Checks

```sh
bun run typecheck
bunx expo-doctor
bunx expo export --platform ios
```
