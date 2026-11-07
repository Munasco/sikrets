"""Settings that read secrets from the environment; nothing here is a secret."""
import os
from dataclasses import dataclass, field

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
api_key = os.environ.get("OPENAI_API_KEY")
stripe_secret_key = os.getenv("STRIPE_SECRET_KEY", default=None)
DATABASE_PASSWORD = env("DATABASE_PASSWORD")
AUTH_PASSWORD_VALIDATORS = [{"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"}]
SESSION_COOKIE_NAME = "sessionid"
TOKEN_URL = "https://oauth2.googleapis.com/token"
password_reset_token_generator = PasswordResetTokenGenerator()


@dataclass
class Credentials:
    password: str = field(default_factory=generate_password_hash)
    api_key: str | None = None
    token_type: str = "Bearer"


def check(token, expected_token):
    if token == expected_token:
        return True
    secret = load_secret(name="payments/stripe")
    tokens = tokenizer.encode(text, add_special_tokens=False)
    return hmac.compare_digest(secret.encode(), token.encode())
