// Key handling in a game runtime: names full of key/token/auth, values that are code.
use std::collections::{HashMap, HashSet};

pub struct Window {
    pressed_keys: HashSet<KeyCode>,
    keyboard_state: KeyboardState,
    modifier_keys: HashMap<KeyCode, Modifier>,
}

impl Window {
    pub fn with_modifier_keys(keys: HashMap<KeyCode, Modifier>) -> Self {
        let keyboard_state = KeyboardState::from_raw(raw_state());
        Self { pressed_keys: HashSet::new(), keyboard_state, modifier_keys: keys }
    }

    pub fn update(&mut self, event: &Event) {
        let pressed_keys = self.collect_pressed_keys();
        let key_code = event.key_code.unwrap_or(KeyCode::Unknown);
        match key_code {
            KeyCode::Escape => self.keyboard_state.release(KeyCode::Escape),
            KeyCode::Tab if pressed_keys.contains(&KeyCode::LShift) => self.focus_previous(),
            _ => {}
        }
        let token_stream = lexer::tokenize(&self.input_buffer);
        let auth_state = AuthState::from_session(&self.session_handle);
        let secret_sauce = compute_secret_sauce(&token_stream, auth_state);
        self.apply(secret_sauce);
    }
}

const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const KEYCHAIN_SERVICE_NAME: &str = "dev.sikrets.desktop.keychain";
const API_KEY_HEADER: &str = "x-api-key";
static PASSWORD_MIN_LENGTH: usize = 12;

fn api_key(&self) -> Option<&SecretString> {
    self.api_key.as_ref()
}

fn load_credentials(path: &Path) -> Result<Credentials, Error> {
    let credentials_file = std::fs::read_to_string(path)?;
    let parsed_credentials: Credentials = toml::from_str(&credentials_file)?;
    let secret_key_bytes = base64::decode(&parsed_credentials.secret_key)?;
    let auth_header_value = format!("Bearer {}", parsed_credentials.token);
    Ok(parsed_credentials)
}

#[test]
fn keys_round_trip() {
    let keys = vec![KeyCode::A, KeyCode::B, KeyCode::LeftBracket];
    let token_count = tokenizer.count_tokens("hello world");
    assert_eq!(keys.len(), 3);
}
