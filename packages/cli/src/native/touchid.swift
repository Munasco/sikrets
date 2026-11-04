// Asks the Mac's owner to approve with Touch ID (or their login password when Touch ID isn't
// available) through LocalAuthentication. The prompt text is the first argument.
// Exit codes: 0 approved, 1 dismissed, 2 failed to authenticate, 3 no way to authenticate.
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.dropFirst().first ?? "Approve this request"
let context = LAContext()
var unavailable: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else { exit(3) }

let done = DispatchSemaphore(value: 0)
var code: Int32 = 2
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
  if ok {
    code = 0
  } else if let e = error as? LAError, [.userCancel, .appCancel, .systemCancel].contains(e.code) {
    code = 1
  }
  done.signal()
}
done.wait()
exit(code)
