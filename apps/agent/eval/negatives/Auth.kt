package dev.sikrets.auth

// Kotlin and Java style: typed declarations whose values are calls.

class TokenRepository(private val tokenStore: TokenStore) {
    val refreshToken: String = tokenStore.refreshTokenFor(account) ?: return null
    private val accessTokenUrl = config.getString("oauth.accessTokenUrl")
    private val keyAlias = "sikrets_master_key_alias"
    private val apiKeyHeader: String = "X-Api-Key"

    fun authorize(request: Request): Boolean {
        val authToken = request.header("Authorization")?.removePrefix("Bearer ")
        val secretKeySpec = SecretKeySpec(keyBytes, "HmacSHA256")
        return authToken != null && tokenStore.isValid(authToken)
    }
}
