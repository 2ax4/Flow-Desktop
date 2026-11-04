//! The signed-in YouTube account: session cookies captured from a login webview
//! live in the OS keychain (profile-scoped, like scrobbling), and authed
//! InnerTube calls — live chat send and account info — build on them.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::api::innertube::InnertubeClient;
use crate::api::innertube::core::clients;
use crate::api::innertube::transport::request::AuthHeaders;
use crate::errors::{AppError, AppResult};
use crate::models::youtube_account::{SendChatOutcome, YouTubeAccountInfo};
use crate::profiles::ActiveProfile;
use crate::scrobble::credentials::ProfileScoped;
use crate::security::keychain::{self, CredentialStore, Keychain};

/// The login webview's label.
pub const LOGIN_WINDOW_LABEL: &str = "yt-login";
/// Event the frontend listens on for account-state changes.
pub const STATE_EVENT: &str = "yt-account://state";
/// The origin every authed request is signed for.
pub const YOUTUBE_ORIGIN: &str = "https://www.youtube.com";

const KEYCHAIN_SERVICE: &str = if cfg!(debug_assertions) {
    "io.github.aedev.flow.desktop.youtube.dev"
} else {
    "io.github.aedev.flow.desktop.youtube"
};
const COOKIES_ENTRY: &str = "YOUTUBE_COOKIES";
/// How long a resolved account is reused before the next status call asks again.
const WHOAMI_CACHE: Duration = Duration::from_secs(600);
/// How often the login window's cookies are polled.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
/// Cookies kept from the login webview; SAPISID (or its 3P twin) signs requests.
const STORED_COOKIE_NAMES: [&str; 9] = [
    "SAPISID",
    "__Secure-3PAPISID",
    "SID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "HSID",
    "SSID",
    "APISID",
    "SAPISID1P",
];

/// The session in the keychain.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCookies {
    cookies: BTreeMap<String, String>,
}

pub struct YouTubeAccountService {
    store: Arc<dyn CredentialStore>,
    extractor: Arc<InnertubeClient>,
    cache: std::sync::Mutex<Option<(Instant, YouTubeAccountInfo)>>,
}

/// One watcher for the login window. A second start while one runs is ignored:
/// the running watcher polls whichever window carries the label.
static LOGIN_WATCH_ACTIVE: AtomicBool = AtomicBool::new(false);

impl YouTubeAccountService {
    pub fn new(store: Arc<dyn CredentialStore>, extractor: Arc<InnertubeClient>) -> Self {
        Self {
            store,
            extractor,
            cache: std::sync::Mutex::new(None),
        }
    }

    /// The profile-scoped keychain store, built where the active profile is known.
    pub fn profile_store(profile: &ActiveProfile) -> Arc<dyn CredentialStore> {
        Arc::new(ProfileScoped::new(Keychain::new(KEYCHAIN_SERVICE), profile))
    }

    pub async fn load_cookies(&self) -> Result<Option<BTreeMap<String, String>>, AppError> {
        let store = self.store.clone();
        let raw = keychain::off_thread(move || store.read(COOKIES_ENTRY))
            .await
            .map_err(|error| AppError::Keychain(error.to_string()))?;
        Ok(raw.and_then(|raw| {
            serde_json::from_str::<StoredCookies>(&raw)
                .ok()
                .map(|stored| stored.cookies)
        }))
    }

    pub async fn save_cookies(&self, cookies: BTreeMap<String, String>) -> Result<(), AppError> {
        let value = serde_json::to_string(&StoredCookies { cookies })
            .map_err(|_| AppError::Keychain("Could not encode the YouTube session".into()))?;
        let store = self.store.clone();
        keychain::off_thread(move || store.write(COOKIES_ENTRY, &value))
            .await
            .map_err(|error| AppError::Keychain(error.to_string()))?;
        self.clear_cache();
        Ok(())
    }

    pub async fn delete_cookies(&self) -> Result<(), AppError> {
        let store = self.store.clone();
        keychain::off_thread(move || store.remove(COOKIES_ENTRY))
            .await
            .map_err(|error| AppError::Keychain(error.to_string()))?;
        self.clear_cache();
        Ok(())
    }

    /// The account state the frontend sees: keychain presence, plus the channel
    /// from a cached or fresh `accounts_list` call.
    pub async fn status(&self) -> YouTubeAccountInfo {
        let cookies = match self.load_cookies().await {
            Ok(Some(cookies)) => cookies,
            Ok(None) => return YouTubeAccountInfo::default(),
            Err(error) => {
                tracing::warn!(%error, "Could not read the YouTube session");
                return YouTubeAccountInfo::default();
            }
        };
        let cached = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .filter(|(read_at, _)| read_at.elapsed() < WHOAMI_CACHE);
        if let Some((_, info)) = cached {
            return info;
        }
        // Cookies exist; resolve the channel behind them. A failure keeps the
        // session valid with its details unavailable.
        let info = self.whoami(&cookies).await.unwrap_or(YouTubeAccountInfo {
            signed_in: true,
            channel_name: None, // channel info unavailable
            channel_id: None,
            photo_url: None,
        });
        if info.channel_name.is_some() {
            self.set_cache(info.clone());
        }
        info
    }

    /// The keychain's view of sign-in, without a network call; used when the
    /// login window closes before a session was captured.
    pub async fn state_without_info(&self) -> YouTubeAccountInfo {
        if let Some((_, info)) = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            return info;
        }
        let signed_in = matches!(self.load_cookies().await, Ok(Some(_)));
        YouTubeAccountInfo {
            signed_in,
            ..YouTubeAccountInfo::default()
        }
    }

    /// Sends one chat message to a live stream as the signed-in account.
    pub async fn send_live_chat(
        &self,
        video_id: &str,
        channel_id: &str,
        text: &str,
    ) -> AppResult<SendChatOutcome> {
        let not_signed_in =
            || AppError::NotSignedIn("Sign in to YouTube to send chat messages".into());
        let cookies = match self.load_cookies().await {
            Ok(Some(cookies)) => cookies,
            Ok(None) => return Err(not_signed_in()),
            Err(error) => return Err(error),
        };
        let Some(auth) = auth_headers(&cookies) else {
            return Err(not_signed_in());
        };
        let mut payload = serde_json::json!({
            "params": encode_live_message_params(channel_id, video_id),
            "richMessage": { "textSegments": [{ "text": text }] },
            "clientMessageId": uuid::Uuid::new_v4().to_string(),
        });
        match self
            .extractor
            .post_innertube_authed("live_chat/send_message", &clients::WEB, &mut payload, &auth)
            .await
        {
            // The live endpoint answers a session it no longer accepts with HTTP 401.
            Err(ref error @ AppError::Extractor(ref message)) if message.contains("status 401") => {
                Ok(SendChatOutcome {
                    ok: false,
                    error_kind: Some("not_signed_in".into()),
                    error_message: Some(error.to_string()),
                    message_id: None,
                })
            }
            Ok(response) => Ok(outcome_from_response(&response)),
            Err(error) => Err(error),
        }
    }

    /// The signed-in channel, from `account/accounts_list` with the session cookies.
    async fn whoami(&self, cookies: &BTreeMap<String, String>) -> Option<YouTubeAccountInfo> {
        let auth = auth_headers(cookies)?;
        let mut payload = serde_json::json!({});
        let response = self
            .extractor
            .post_innertube_authed("account/accounts_list", &clients::WEB, &mut payload, &auth)
            .await
            .ok()?;
        parse_account_info(&response)
    }

    fn clear_cache(&self) {
        *self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    fn set_cache(&self, info: YouTubeAccountInfo) {
        *self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((Instant::now(), info));
    }
}

/// Starts watching the login window's cookies. One watcher at a time.
pub fn spawn_login_watch<R: Runtime + 'static>(app: AppHandle<R>) {
    if LOGIN_WATCH_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        watch_login_window(app).await;
        LOGIN_WATCH_ACTIVE.store(false, Ordering::SeqCst);
    });
}

async fn watch_login_window<R: Runtime>(app: AppHandle<R>) {
    loop {
        tokio::time::sleep(WATCH_INTERVAL).await;
        let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) else {
            tracing::info!("YouTube login window closed before sign-in");
            let state = match app.try_state::<YouTubeAccountService>() {
                Some(service) => service.state_without_info().await,
                None => YouTubeAccountInfo::default(),
            };
            emit_state(&app, state);
            return;
        };
        let Ok(url) = tauri::Url::parse(YOUTUBE_ORIGIN) else {
            return;
        };
        let cookies = window.cookies_for_url(url).unwrap_or_default();
        let session: BTreeMap<String, String> = cookies
            .into_iter()
            .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
            .collect();
        let Some(captured) = capture_cookies(&session) else {
            continue;
        };

        let Some(service) = app.try_state::<YouTubeAccountService>() else {
            return;
        };
        if let Err(error) = service.save_cookies(captured).await {
            tracing::warn!(%error, "Could not store the YouTube session");
            continue;
        }
        emit_state(&app, service.status().await);
        let _ = window.close();
        tracing::info!("YouTube session captured from the login window");
        return;
    }
}

pub fn emit_state<R: Runtime>(app: &AppHandle<R>, info: YouTubeAccountInfo) {
    if let Err(error) = app.emit(STATE_EVENT, &info) {
        tracing::warn!(%error, "Could not emit the YouTube account state");
    }
}

/// The session worth keeping, once both halves of a signed-in YouTube session
/// are present: a SAPISID (or its 3P twin) that signs requests, and a
/// SID-family cookie that identifies it.
fn capture_cookies(cookies: &BTreeMap<String, String>) -> Option<BTreeMap<String, String>> {
    let has_sapisid = cookies.contains_key("SAPISID") || cookies.contains_key("__Secure-3PAPISID");
    let has_sid = cookies.contains_key("SID")
        || cookies.contains_key("__Secure-1PSID")
        || cookies.contains_key("__Secure-3PSID");
    if !(has_sapisid && has_sid) {
        return None;
    }
    Some(
        STORED_COOKIE_NAMES
            .iter()
            .filter_map(|name| {
                cookies
                    .get(*name)
                    .map(|value| ((*name).to_string(), value.clone()))
            })
            .collect(),
    )
}

/// Cookie header plus `SAPISIDHASH` authorization for one authed call.
fn auth_headers(cookies: &BTreeMap<String, String>) -> Option<AuthHeaders> {
    let sapisid = cookies
        .get("SAPISID")
        .or_else(|| cookies.get("__Secure-3PAPISID"))
        .filter(|value| !value.is_empty())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    let authorization = sapisidhash_authorization(sapisid, timestamp);
    let cookie = cookies
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    (!cookie.is_empty()).then_some(AuthHeaders {
        cookie,
        authorization,
    })
}

fn sapisidhash_authorization(sapisid: &str, timestamp: u64) -> String {
    format!(
        "SAPISIDHASH {timestamp}_{}",
        hex_sha1(&format!("{timestamp} {sapisid} {YOUTUBE_ORIGIN}"))
    )
}

fn hex_sha1(input: &str) -> String {
    Sha1::digest(input.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The `params` field of `live_chat/send_message`: a hand-encoded
/// `LiveMessageParams` protobuf, double-wrapped the way the web client does —
/// YouTube.js computes `btoa(encodeURIComponent(u8ToBase64(bytes)))`.
fn encode_live_message_params(channel_id: &str, video_id: &str) -> String {
    let bytes = live_message_params_bytes(channel_id, video_id);
    let first = base64::engine::general_purpose::STANDARD.encode(bytes);
    let encoded = encode_uri_component(&first);
    base64::engine::general_purpose::STANDARD.encode(encoded.as_bytes())
}

/// `LiveMessageParams { params { ids { channel_id = 1, video_id = 2 } } = 1,
/// number0 = 2, number1 = 3 }` with `number0 = 1`, `number1 = 4`.
fn live_message_params_bytes(channel_id: &str, video_id: &str) -> Vec<u8> {
    let mut ids = wire_field(1, channel_id.as_bytes());
    ids.extend(wire_field(2, video_id.as_bytes()));
    let params = wire_field(5, &ids);
    let mut out = wire_field(1, &params);
    out.extend_from_slice(&[0x10, 0x01, 0x18, 0x04]);
    out
}

/// One length-delimited protobuf field.
fn wire_field(field: u32, value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 2);
    write_varint(&mut out, u64::from(field) << 3 | 0b10);
    write_varint(&mut out, value.len() as u64);
    out.extend_from_slice(value);
    out
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// JavaScript's `encodeURIComponent`, which the params encoding relies on.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Maps a `send_message` answer: either the posted message, or the refusal.
fn outcome_from_response(response: &serde_json::Value) -> SendChatOutcome {
    if let Some(error) = response.get("error") {
        let status = error["status"].as_str().unwrap_or_default();
        let message = error["message"].as_str().unwrap_or_default();
        let lowered_status = status.to_ascii_lowercase();
        let lowered_message = message.to_ascii_lowercase();
        let kind = if status.contains("UNAUTHENTICATED") {
            "not_signed_in"
        } else if ["rate", "slow"]
            .iter()
            .any(|word| lowered_status.contains(word) || lowered_message.contains(word))
        {
            "rate_limited"
        } else {
            "rejected"
        };
        return SendChatOutcome {
            ok: false,
            error_kind: Some(kind.to_string()),
            error_message: (!message.is_empty()).then(|| message.to_string()),
            message_id: None,
        };
    }
    SendChatOutcome {
        ok: response.get("actions").is_some(),
        error_kind: response.get("actions").is_none().then(|| "rejected".into()),
        error_message: None,
        message_id: sent_message_id(response),
    }
}

/// The posted message's chat item id, from the first returned action.
fn sent_message_id(response: &serde_json::Value) -> Option<String> {
    response["actions"][0]["addChatItemAction"]["item"]
        .as_object()?
        .values()
        .find_map(|renderer| renderer["id"].as_str())
        .map(ToOwned::to_owned)
}

/// Every account item in an `accounts_list` answer, in document order.
fn collect_account_items<'a>(value: &'a serde_json::Value, items: &mut Vec<&'a serde_json::Value>) {
    match value {
        serde_json::Value::Object(map) => {
            for key in ["accountItemRenderer", "accountItem"] {
                if let Some(item) = map.get(key) {
                    items.push(item);
                }
            }
            map.values()
                .for_each(|value| collect_account_items(value, items));
        }
        serde_json::Value::Array(values) => {
            values
                .iter()
                .for_each(|value| collect_account_items(value, items));
        }
        _ => {}
    }
}

fn runs_text(value: &serde_json::Value) -> Option<String> {
    value["simpleText"]
        .as_str()
        .or_else(|| value["runs"][0]["text"].as_str())
        .map(ToOwned::to_owned)
}

/// The channel id (`pageId`) carried by the account's select endpoint.
fn find_page_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(tokens) = map
                .get("selectActiveIdentityEndpoint")
                .and_then(|endpoint| endpoint["supportedTokens"].as_array())
            {
                for token in tokens {
                    if let Some(id) = token["pageIdToken"]["pageId"].as_str()
                        && !id.is_empty()
                    {
                        return Some(id.to_string());
                    }
                }
            }
            map.values().find_map(find_page_id)
        }
        serde_json::Value::Array(values) => values.iter().find_map(find_page_id),
        _ => None,
    }
}

/// The selected account, or the first listed one.
fn parse_account_info(response: &serde_json::Value) -> Option<YouTubeAccountInfo> {
    let mut items = Vec::new();
    collect_account_items(response, &mut items);
    let item = items
        .iter()
        .find(|item| item["isSelected"].as_bool().unwrap_or(false))
        .copied()
        .or_else(|| items.first().copied())?;
    Some(YouTubeAccountInfo {
        signed_in: true,
        channel_name: runs_text(&item["accountName"]),
        channel_id: find_page_id(&item["serviceEndpoint"]),
        photo_url: item["accountPhoto"]["thumbnails"]
            .as_array()
            .and_then(|thumbnails| thumbnails.last())
            .and_then(|thumbnail| thumbnail["url"].as_str())
            .map(ToOwned::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use serde_json::json;

    #[test]
    fn params_are_the_hand_encoded_protobuf_double_wrapped() {
        let bytes = live_message_params_bytes("UCabc123", "dQw4w9WgXcQ");
        let mut expected: Vec<u8> = Vec::new();
        // outer field 1 (params), length 0x19
        expected.extend_from_slice(&[0x0A, 0x19, 0x2A, 0x17]);
        // ids: field 1 (channel id), field 2 (video id)
        expected.extend_from_slice(&[0x0A, 0x08]);
        expected.extend_from_slice(b"UCabc123");
        expected.extend_from_slice(&[0x12, 0x0B]);
        expected.extend_from_slice(b"dQw4w9WgXcQ");
        // number0 = 1, number1 = 4
        expected.extend_from_slice(&[0x10, 0x01, 0x18, 0x04]);
        assert_eq!(bytes, expected);

        // Reference encoding: btoa(encodeURIComponent(base64(bytes))).
        assert_eq!(
            encode_live_message_params("UCabc123", "dQw4w9WgXcQ"),
            "Q2hrcUZ3b0lWVU5oWW1NeE1qTVNDMlJSZHpSM09WZG5XR05SRUFFWUJBJTNEJTNE"
        );
    }

    #[test]
    fn uri_component_encoding_matches_javascript() {
        assert_eq!(encode_uri_component("ab+/=z"), "ab%2B%2F%3Dz");
        assert_eq!(
            encode_uri_component("a-b_c.d!e~f*g'h(i)j"),
            "a-b_c.d!e~f*g'h(i)j"
        );
    }

    #[test]
    fn sapisidhash_is_the_documented_digest() {
        let header = sapisidhash_authorization("TESTSAPISID0123456789abcdef", 1_700_000_000);
        assert_eq!(
            header,
            "SAPISIDHASH 1700000000_14d53774e91806825be7c2264891c8f8c1035200"
        );
        // SAPISIDHASH <seconds>_<40 lowercase hex digits>
        let (scheme, rest) = header.split_once(' ').unwrap();
        assert_eq!(scheme, "SAPISIDHASH");
        let (timestamp, digest) = rest.split_once('_').unwrap();
        assert!(!timestamp.is_empty() && timestamp.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(digest.len(), 40);
        assert!(
            digest
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
    }

    #[test]
    fn a_session_is_captured_only_with_both_halves() {
        let half = BTreeMap::from([
            ("SID".to_string(), "s".into()),
            ("HSID".to_string(), "h".into()),
        ]);
        assert!(capture_cookies(&half).is_none());
        let other_half = BTreeMap::from([
            ("SAPISID".to_string(), "a".into()),
            ("__Secure-1PSID".to_string(), "p".into()),
            ("IGNORED".to_string(), "x".into()),
        ]);
        let captured = capture_cookies(&other_half).unwrap();
        assert_eq!(
            captured,
            BTreeMap::from([
                ("SAPISID".to_string(), "a".into()),
                ("__Secure-1PSID".to_string(), "p".into()),
            ])
        );
    }

    #[test]
    fn cookies_round_trip_through_the_stored_shape() {
        let stored = StoredCookies {
            cookies: BTreeMap::from([("SAPISID".to_string(), "v".into())]),
        };
        let raw = serde_json::to_string(&stored).unwrap();
        assert_eq!(serde_json::from_str::<StoredCookies>(&raw).unwrap(), stored);
    }

    #[test]
    fn send_outcomes_map_the_server_error_kinds() {
        let outcome = outcome_from_response(&json!({
            "error": { "status": "UNAUTHENTICATED", "message": "Request is missing required authentication credential" }
        }));
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("not_signed_in"));
        assert!(outcome.message_id.is_none());

        let outcome = outcome_from_response(&json!({
            "error": { "status": "FAILED_PRECONDITION", "message": "Chat is in slow mode, try again later" }
        }));
        assert_eq!(outcome.error_kind.as_deref(), Some("rate_limited"));

        let outcome = outcome_from_response(&json!({
            "error": { "status": "INVALID_ARGUMENT", "message": "Request contains an invalid argument" }
        }));
        assert_eq!(outcome.error_kind.as_deref(), Some("rejected"));
        assert_eq!(
            outcome.error_message.as_deref(),
            Some("Request contains an invalid argument")
        );
    }

    #[test]
    fn a_successful_send_reports_the_message_id() {
        let outcome = outcome_from_response(&json!({
            "actions": [{ "addChatItemAction": { "item": {
                "liveChatTextMessageRenderer": { "id": "msg-1", "message": { "runs": [{ "text": "hi" }] } }
            } } }]
        }));
        assert!(outcome.ok);
        assert_eq!(outcome.error_kind, None);
        assert_eq!(outcome.message_id.as_deref(), Some("msg-1"));

        let outcome = outcome_from_response(&json!({}));
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("rejected"));
    }

    #[test]
    fn auth_headers_need_a_sapisid_and_carry_the_whole_session() {
        let cookies = BTreeMap::from([
            ("SAPISID".to_string(), "a".into()),
            ("__Secure-1PSID".to_string(), "p".into()),
        ]);
        let headers = auth_headers(&cookies).unwrap();
        assert_eq!(headers.cookie, "SAPISID=a; __Secure-1PSID=p");
        let authorization = headers.authorization;
        let (scheme, rest) = authorization.split_once(' ').unwrap();
        assert_eq!(scheme, "SAPISIDHASH");
        let (timestamp, digest) = rest.split_once('_').unwrap();
        assert!(!timestamp.is_empty() && timestamp.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(digest.len(), 40);

        assert!(auth_headers(&BTreeMap::from([("SID".to_string(), "s".into())])).is_none());
    }

    #[test]
    fn the_first_base64_layer_of_the_params_is_the_raw_protobuf() {
        let bytes = live_message_params_bytes("UCabc123", "dQw4w9WgXcQ");
        assert_eq!(
            STANDARD.encode(bytes),
            "ChkqFwoIVUNhYmMxMjMSC2RRdzR3OVdnWGNREAEYBA=="
        );
    }

    #[test]
    fn the_selected_account_is_parsed_from_the_accounts_list() {
        let response = json!({
            "contents": [{ "accountSectionListRenderer": { "contents": [{
                "accountItemSectionRenderer": { "contents": [{
                    "accountItemRenderer": {
                        "accountName": { "runs": [{ "text": "My Channel" }] },
                        "accountPhoto": { "thumbnails": [
                            { "url": "https://yt3.ggpht.com/small" },
                            { "url": "https://yt3.ggpht.com/big" }
                        ] },
                        "isSelected": true,
                        "serviceEndpoint": { "selectActiveIdentityEndpoint": { "supportedTokens": [
                            { "pageIdToken": { "pageId": "UCabc123def45" } }
                        ] } }
                    }
                }] }
            }] } }]
        });
        let info = parse_account_info(&response).unwrap();
        assert!(info.signed_in);
        assert_eq!(info.channel_name.as_deref(), Some("My Channel"));
        assert_eq!(info.channel_id.as_deref(), Some("UCabc123def45"));
        assert_eq!(info.photo_url.as_deref(), Some("https://yt3.ggpht.com/big"));
    }

    #[test]
    fn the_selected_account_wins_over_the_first_listed() {
        let response = json!({ "contents": [
            { "accountItemRenderer": { "accountName": { "simpleText": "Other" }, "isSelected": false } },
            { "accountItemRenderer": { "accountName": { "simpleText": "Mine" }, "isSelected": true } }
        ] });
        let info = parse_account_info(&response).unwrap();
        assert_eq!(info.channel_name.as_deref(), Some("Mine"));
        assert_eq!(info.channel_id, None, "no select endpoint, no id");
    }

    #[test]
    fn an_answer_without_accounts_stays_unparsed() {
        assert!(parse_account_info(&json!({ "contents": [] })).is_none());
    }
}
