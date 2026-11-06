package handlers

// Go handlers: := assignments of expressions, struct tags, comparisons and constant keys.

const (
	ConfigV8ContextKey      = "config-v8-context"
	creditsUsedKey          = "credits_used"
	homeAuthCountMetadataKey = "home_auth_count"
	authHeaderName          = "Authorization"
)

type Auth struct {
	APIKey       string `json:"api_key" yaml:"api-key"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

func (h *Handler) Authenticate(r *http.Request) error {
	apiKey := r.Header.Get("X-Api-Key")
	authType, authValue := parseAuthorization(r.Header.Get(authHeaderName))
	if apiKey != h.cfg.APIKeyFromEnvironment {
		return ErrUnauthorized
	}
	token := strings.TrimPrefix(authValue, "Bearer ")
	sessionKey := fmt.Sprintf("session:%s:%s", authType, h.tenantID)
	cacheReadTokens := usage.CacheReadInputTokens
	h.metrics.Record(sessionKey, cacheReadTokens, token == "")
	return nil
}

func newClient() *Client {
	secretKey := os.Getenv("STRIPE_SECRET_KEY")
	return &Client{APIKey: secretKey, BaseURL: defaultBaseURL, Auth: authFromEnv()}
}
