// This device's identity keys, held in the Secure Enclave with no user-presence requirement, so
// nothing here ever prompts. A key's private half never leaves the Enclave: what is stored is its
// dataRepresentation, an opaque blob that only this Mac's Enclave can use. The blob is written to
// and read from a file path given as an argument and never passes through stdout.
//
//   available                      exit 0 when the Secure Enclave can be used, 3 when it can't
//   create signing|agreement FILE  new key; writes its blob to FILE (0600), prints the public key
//   public signing|agreement FILE  prints the public key of an existing blob
//   sign FILE                      signs stdin (ECDSA P-256, SHA-256), prints the raw r||s signature
//   unwrap FILE                    stdin is {epk, iv, ct, tag, salt, info, aad} (base64); ECDH with
//                                  the ephemeral key, HKDF-SHA256, AES-GCM open; prints the key
//
// Output is one line of base64 (public keys are X9.63 uncompressed points). Errors go to stderr
// as a short reason only. Exit codes: 0 ok, 1 bad usage or input, 2 operation failed, 3 no Enclave.
import CryptoKit
import Foundation

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func out(_ data: Data) {
  FileHandle.standardOutput.write(Data((data.base64EncodedString() + "\n").utf8))
}

func readBlob(_ path: String) -> Data {
  guard let blob = FileManager.default.contents(atPath: path) else { fail(1, "no key at that path") }
  return blob
}

func writeBlob(_ path: String, _ blob: Data) {
  if FileManager.default.fileExists(atPath: path) { fail(1, "a key already exists at that path") }
  guard FileManager.default.createFile(atPath: path, contents: blob, attributes: [.posixPermissions: 0o600]) else { fail(2, "couldn't write the key") }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(1, "usage: available | create | public | sign | unwrap") }
guard SecureEnclave.isAvailable else { fail(3, "no Secure Enclave") }

do {
  switch (command, args.count) {
  case ("available", 1):
    exit(0)
  case ("create", 3) where args[1] == "signing":
    let key = try SecureEnclave.P256.Signing.PrivateKey()
    writeBlob(args[2], key.dataRepresentation)
    out(key.publicKey.x963Representation)
  case ("create", 3) where args[1] == "agreement":
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey()
    writeBlob(args[2], key.dataRepresentation)
    out(key.publicKey.x963Representation)
  case ("public", 3) where args[1] == "signing":
    out(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: readBlob(args[2])).publicKey.x963Representation)
  case ("public", 3) where args[1] == "agreement":
    out(try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: readBlob(args[2])).publicKey.x963Representation)
  case ("sign", 2):
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: readBlob(args[1]))
    out(try key.signature(for: FileHandle.standardInput.readDataToEndOfFile()).rawRepresentation)
  case ("unwrap", 2):
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: readBlob(args[1]))
    guard let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: String] else { fail(1, "expected a JSON object") }
    func field(_ name: String) -> Data {
      guard let s = input[name], let d = Data(base64Encoded: s) else { fail(1, "missing \(name)") }
      return d
    }
    let epk = try P256.KeyAgreement.PublicKey(x963Representation: field("epk"))
    let shared = try key.sharedSecretFromKeyAgreement(with: epk)
    let wrapping = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: field("salt"), sharedInfo: field("info"), outputByteCount: 32)
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: field("iv")), ciphertext: field("ct"), tag: field("tag"))
    guard let opened = try? AES.GCM.open(box, using: wrapping, authenticating: field("aad")) else { fail(2, "couldn't unwrap: wrapped for another key, or changed") }
    out(opened)
  default:
    fail(1, "usage: available | create signing|agreement FILE | public signing|agreement FILE | sign FILE | unwrap FILE")
  }
} catch {
  fail(2, "the Secure Enclave refused the operation")
}
