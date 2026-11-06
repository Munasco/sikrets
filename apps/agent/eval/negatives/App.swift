import Foundation

// Swift: keychain lookups and typed properties.
struct KeychainConfig {
    let serviceKey: String = Bundle.main.bundleIdentifier ?? "dev.sikrets.app"
    let accessGroup = "group.dev.sikrets.shared"
    var apiKey: String? { KeychainStore.shared.string(forKey: Self.apiKeyAccount) }
    static let apiKeyAccount = "openai-api-key"
}

func authenticate() async throws {
    let token = try await AuthSession.shared.refreshToken(for: account)
    let secretKey = SymmetricKey(size: .bits256)
    let passwordField = NSSecureTextField(frame: .zero)
    print(token.count, secretKey.bitCount, passwordField.stringValue)
}
