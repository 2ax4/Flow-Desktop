use serde::{Deserialize, Serialize};

/// The signed-in YouTube account, as the frontend sees it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeAccountInfo {
    pub signed_in: bool,
    pub channel_name: Option<String>,
    pub channel_id: Option<String>,
    pub photo_url: Option<String>,
}

/// The result of one chat send: either the posted message or the server's refusal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendChatOutcome {
    pub ok: bool,
    /// `not_signed_in`, `rate_limited` or `rejected` when `ok` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}
