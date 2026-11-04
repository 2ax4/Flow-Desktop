use serde_json::Value;
use tracing::debug;

use crate::api::innertube::InnertubeClient;
use crate::api::innertube::core::clients;
use crate::api::innertube::extractors::watch_next;
use crate::api::innertube::json::thumbnail::largest_url;
use crate::errors::AppResult;
use crate::models::live_chat::{
    LiveChatMessage, LiveChatPoll, LiveChatPollOption, LiveChatResponse, LiveChatSegment,
};

const DEFAULT_POLL_MS: u64 = 2000;
const MIN_POLL_MS: u64 = 1000;
const MAX_POLL_MS: u64 = 15000;

fn parse_message_runs(message: &Value) -> (String, Vec<LiveChatSegment>) {
    let mut text = String::new();
    let mut segments = Vec::new();

    let Some(runs) = message["runs"].as_array() else {
        return (text, segments);
    };

    for run in runs {
        if let Some(run_text) = run["text"].as_str() {
            text.push_str(run_text);
            segments.push(LiveChatSegment {
                text: run_text.to_string(),
                emoji_image_url: None,
            });
        } else if let Some(emoji) = run.get("emoji") {
            let is_custom = emoji["isCustomEmoji"].as_bool().unwrap_or(false);
            let emoji_id = emoji["emojiId"].as_str().unwrap_or_default();

            if !is_custom && !emoji_id.is_empty() {
                text.push_str(emoji_id);
                segments.push(LiveChatSegment {
                    text: emoji_id.to_string(),
                    emoji_image_url: None,
                });
            } else {
                let shortcut = emoji["shortcuts"][0].as_str().unwrap_or(emoji_id);
                text.push_str(shortcut);
                segments.push(LiveChatSegment {
                    text: shortcut.to_string(),
                    emoji_image_url: largest_url(&emoji["image"]["thumbnails"]),
                });
            }
        }
    }

    (text, segments)
}

fn parse_renderer(renderer: &Value, message_type: &str) -> Option<LiveChatMessage> {
    let id = renderer["id"].as_str()?.to_string();

    let (message, segments) = {
        let (text, segs) = parse_message_runs(&renderer["message"]);
        if message_type == "membership" && text.trim().is_empty() {
            parse_message_runs(&renderer["headerSubtext"])
        } else {
            (text, segs)
        }
    };

    let mut is_owner = false;
    let mut is_moderator = false;
    let mut is_verified = false;
    let mut is_member = false;
    let mut member_badge_url = None;
    if let Some(badges) = renderer["authorBadges"].as_array() {
        for badge in badges {
            let badge_renderer = &badge["liveChatAuthorBadgeRenderer"];
            match badge_renderer["icon"]["iconType"]
                .as_str()
                .unwrap_or_default()
                .to_ascii_uppercase()
                .as_str()
            {
                "OWNER" => is_owner = true,
                "MODERATOR" => is_moderator = true,
                "VERIFIED" => is_verified = true,
                _ => {}
            }
            if let Some(url) = largest_url(&badge_renderer["customThumbnail"]["thumbnails"]) {
                is_member = true;
                member_badge_url = Some(url);
            }
        }
    }

    let author = renderer["authorName"]["simpleText"]
        .as_str()
        .or_else(|| renderer["authorName"]["runs"][0]["text"].as_str())
        .unwrap_or_default()
        .to_string();

    Some(LiveChatMessage {
        id,
        author,
        author_photo_url: largest_url(&renderer["authorPhoto"]["thumbnails"]),
        message,
        segments,
        timestamp: renderer["timestampText"]["simpleText"]
            .as_str()
            .map(ToOwned::to_owned),
        message_type: message_type.to_string(),
        is_owner,
        is_moderator,
        is_verified,
        is_member,
        member_badge_url,
        super_chat_amount: renderer["purchaseAmountText"]["simpleText"]
            .as_str()
            .map(ToOwned::to_owned),
        super_chat_argb: renderer["bodyBackgroundColor"].as_i64(),
        super_chat_header_argb: renderer["headerBackgroundColor"].as_i64(),
        video_offset_ms: None,
    })
}

fn parse_chat_item(item: &Value) -> Option<LiveChatMessage> {
    if let Some(renderer) = item.get("liveChatTextMessageRenderer") {
        return parse_renderer(renderer, "text");
    }
    if let Some(renderer) = item.get("liveChatPaidMessageRenderer") {
        return parse_renderer(renderer, "superChat");
    }
    if let Some(renderer) = item.get("liveChatMembershipItemRenderer") {
        return parse_renderer(renderer, "membership");
    }
    None
}

fn parse_poll(renderer: &Value) -> Option<LiveChatPoll> {
    let choices = renderer["pollChoices"].as_array()?;
    let options: Vec<LiveChatPollOption> = choices
        .iter()
        .filter_map(|choice| {
            let choice = &choice["pollChoiceRenderer"];
            let text = choice["text"]["simpleText"]
                .as_str()
                .or_else(|| choice["text"]["runs"][0]["text"].as_str())?;
            Some(LiveChatPollOption {
                id: choice["pollOptionId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                text: text.to_string(),
                vote_ratio: choice["voteRatioIfNotVoted"]
                    .as_f64()
                    .or_else(|| choice["voteRatio"].as_f64()),
            })
        })
        .collect();
    Some(LiveChatPoll {
        id: renderer["id"].as_str().unwrap_or_default().to_string(),
        question: renderer["pollQuestion"]["simpleText"]
            .as_str()
            .or_else(|| renderer["pollQuestion"]["runs"][0]["text"].as_str())
            .unwrap_or_default()
            .to_string(),
        options,
        voting_disabled: renderer["votingDisabled"].as_bool().unwrap_or(false),
    })
}

/// One page of chat: its messages (a replay's with their offset into the
/// stream), the tokens that continue it, and when to ask again.
struct ChatPage {
    messages: Vec<LiveChatMessage>,
    next: Option<String>,
    seek: Option<String>,
    polling_interval_ms: u64,
    /// The view selector's "Top chat" and all-messages tokens, in that order.
    views: (Option<String>, Option<String>),
    pinned: Option<LiveChatMessage>,
    poll: Option<LiveChatPoll>,
    deleted: Vec<String>,
}

fn parse_live_chat_page(res: &Value) -> ChatPage {
    let continuation = &res["continuationContents"]["liveChatContinuation"];
    let continuations = continuation["continuations"].as_array();
    let token = |kind: &str| {
        continuations
            .into_iter()
            .flatten()
            .find_map(|entry| entry[kind]["continuation"].as_str())
            .map(ToOwned::to_owned)
    };
    let next = token("timedContinuationData")
        .or_else(|| token("invalidationContinuationData"))
        .or_else(|| token("reloadContinuationData"))
        .or_else(|| token("liveChatReplayContinuationData"));
    let polling_interval_ms = continuations
        .into_iter()
        .flatten()
        .find_map(|entry| {
            entry["timedContinuationData"]["timeoutMs"]
                .as_u64()
                .or_else(|| entry["invalidationContinuationData"]["timeoutMs"].as_u64())
        })
        .unwrap_or(DEFAULT_POLL_MS)
        .clamp(MIN_POLL_MS, MAX_POLL_MS);

    let mut messages = Vec::new();
    let mut pinned = None;
    let mut poll = None;
    let mut deleted = Vec::new();
    for action in continuation["actions"].as_array().into_iter().flatten() {
        if let Some(message) = parse_chat_item(&action["addChatItemAction"]["item"]) {
            messages.push(message);
            continue;
        }
        let replay = &action["replayChatItemAction"];
        let offset = replay["videoOffsetTimeMsec"]
            .as_str()
            .and_then(|offset| offset.parse().ok());
        for replayed in replay["actions"].as_array().into_iter().flatten() {
            if let Some(mut message) = parse_chat_item(&replayed["addChatItemAction"]["item"]) {
                message.video_offset_ms = offset;
                messages.push(message);
            }
        }
        // Pinned banner: addBannerToLiveChatCommand.bannerRenderer
        // .liveChatBannerRenderer.contents holds the pinned chat item.
        if pinned.is_none() {
            pinned = parse_chat_item(
                &action["addBannerToLiveChatCommand"]["bannerRenderer"]["liveChatBannerRenderer"]["contents"],
            );
        }
        if poll.is_none() {
            poll = parse_poll(&action["updateLiveChatPollAction"]["pollToUpdate"]["pollRenderer"]);
        }
        for kind in ["markChatItemAsDeletedAction", "removeChatItemAction"] {
            if let Some(id) = action[kind]["targetItemId"].as_str() {
                deleted.push(id.to_string());
            }
        }
    }

    let views: Vec<Option<String>> = continuation["header"]["liveChatHeaderRenderer"]
        ["viewSelector"]["sortFilterSubMenuRenderer"]["subMenuItems"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            item["continuation"]["reloadContinuationData"]["continuation"]
                .as_str()
                .map(ToOwned::to_owned)
        })
        .collect();

    ChatPage {
        messages,
        next,
        seek: token("playerSeekContinuationData"),
        polling_interval_ms,
        views: (
            views.first().cloned().flatten(),
            views.get(1).cloned().flatten(),
        ),
        pinned,
        poll,
        deleted,
    }
}

impl InnertubeClient {
    /// A page of a video's chat. Without `continuation` the chat is seeded from
    /// the watch answer, which also says whether it is a replay. A replay is
    /// read at `replay_offset_ms` into the stream; a continuation passed with an
    /// offset is a replay's.
    pub async fn get_live_chat(
        &self,
        video_id: &str,
        continuation: Option<String>,
        replay_offset_ms: Option<u64>,
    ) -> AppResult<LiveChatResponse> {
        let video_id_trimmed = video_id.trim();
        let (token, is_replay) = if let Some(token) = continuation.filter(|token| !token.is_empty())
        {
            (token, replay_offset_ms.is_some())
        } else {
            let next = self.watch_next(video_id_trimmed).await?;
            let Some((seed, is_replay)) = watch_next::chat_seed(&next) else {
                debug!(video_id = %video_id_trimmed, "No live chat available");
                return Ok(LiveChatResponse {
                    messages: Vec::new(),
                    continuation: None,
                    polling_interval_ms: 0,
                    is_replay: false,
                    top_chat_continuation: None,
                    all_chat_continuation: None,
                    seek_continuation: None,
                    pinned_message: None,
                    poll: None,
                    deleted_message_ids: Vec::new(),
                });
            };
            (seed, is_replay)
        };

        let res = if is_replay {
            let mut payload = serde_json::json!({
                "continuation": token,
                "currentPlayerState": { "playerOffsetMs": replay_offset_ms.unwrap_or(0).to_string() },
            });
            self.post_innertube(
                "live_chat/get_live_chat_replay",
                &clients::WEB,
                &mut payload,
            )
            .await?
        } else {
            let mut payload = serde_json::json!({ "continuation": token });
            self.post_innertube("live_chat/get_live_chat", &clients::WEB, &mut payload)
                .await?
        };
        let page = parse_live_chat_page(&res);

        Ok(LiveChatResponse {
            messages: page.messages,
            continuation: page.next,
            polling_interval_ms: page.polling_interval_ms,
            is_replay,
            top_chat_continuation: page.views.0,
            all_chat_continuation: page.views.1,
            seek_continuation: page.seek,
            pinned_message: page.pinned,
            poll: page.poll,
            deleted_message_ids: page.deleted,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_message(id: &str) -> Value {
        json!({ "liveChatTextMessageRenderer": {
            "id": id,
            "authorName": { "simpleText": "Viewer" },
            "message": { "runs": [{ "text": "hello" }] }
        } })
    }

    #[test]
    fn replayed_messages_keep_their_offset_and_the_seek_token() {
        let res = json!({ "continuationContents": { "liveChatContinuation": {
            "continuations": [
                { "liveChatReplayContinuationData": { "continuation": "NEXT", "timeUntilLastMessageMsec": 5000 } },
                { "playerSeekContinuationData": { "continuation": "SEEK" } }
            ],
            "actions": [{ "replayChatItemAction": {
                "videoOffsetTimeMsec": "341527",
                "actions": [{ "addChatItemAction": { "item": text_message("a") } }]
            } }]
        } } });
        let page = parse_live_chat_page(&res);
        assert_eq!(page.next.as_deref(), Some("NEXT"));
        assert_eq!(page.seek.as_deref(), Some("SEEK"));
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].video_offset_ms, Some(341_527));
    }

    #[test]
    fn the_view_selector_gives_the_top_and_all_messages_tokens() {
        let res = json!({ "continuationContents": { "liveChatContinuation": {
            "continuations": [{ "invalidationContinuationData": { "continuation": "LIVE", "timeoutMs": 5000 } }],
            "actions": [{ "addChatItemAction": { "item": text_message("b") } }],
            "header": { "liveChatHeaderRenderer": { "viewSelector": { "sortFilterSubMenuRenderer": {
                "subMenuItems": [
                    { "title": "Top chat", "continuation": { "reloadContinuationData": { "continuation": "TOP" } } },
                    { "title": "Live chat", "continuation": { "reloadContinuationData": { "continuation": "ALL" } } }
                ]
            } } } }
        } } });
        let page = parse_live_chat_page(&res);
        assert_eq!(page.next.as_deref(), Some("LIVE"));
        assert_eq!(page.polling_interval_ms, 5000);
        assert_eq!(
            page.views,
            (Some("TOP".to_string()), Some("ALL".to_string()))
        );
        assert_eq!(page.messages[0].video_offset_ms, None);
    }

    #[test]
    fn the_pinned_banner_holds_the_pinned_message() {
        let res = json!({ "continuationContents": { "liveChatContinuation": {
            "actions": [
                { "addBannerToLiveChatCommand": { "bannerRenderer": { "liveChatBannerRenderer": {
                    "contents": text_message("pin-1")
                } } } },
                { "addChatItemAction": { "item": text_message("c") } }
            ]
        } } });
        let page = parse_live_chat_page(&res);
        assert_eq!(page.pinned.as_ref().map(|m| m.id.as_str()), Some("pin-1"));
        assert_eq!(
            page.pinned.as_ref().map(|m| m.message.as_str()),
            Some("hello")
        );
        assert_eq!(
            page.messages.len(),
            1,
            "the banner is not a regular message"
        );
    }

    #[test]
    fn a_poll_update_carries_the_question_and_choice_ratios() {
        let res = json!({ "continuationContents": { "liveChatContinuation": {
            "actions": [{ "updateLiveChatPollAction": { "pollToUpdate": { "pollRenderer": {
                "id": "poll-1",
                "pollQuestion": { "runs": [{ "text": "More music?" }] },
                "pollChoices": [
                    { "pollChoiceRenderer": {
                        "pollOptionId": "opt-1",
                        "text": { "simpleText": "Yes" },
                        "voteRatioIfNotVoted": 0.75
                    } },
                    { "pollChoiceRenderer": {
                        "pollOptionId": "opt-2",
                        "text": { "simpleText": "No" }
                    } }
                ]
            } } } }]
        } } });
        let page = parse_live_chat_page(&res);
        let poll = page.poll.expect("poll parsed");
        assert_eq!(poll.id, "poll-1");
        assert_eq!(poll.question, "More music?");
        assert!(!poll.voting_disabled);
        assert_eq!(poll.options.len(), 2);
        assert_eq!(poll.options[0].id, "opt-1");
        assert_eq!(poll.options[0].text, "Yes");
        assert_eq!(poll.options[0].vote_ratio, Some(0.75));
        assert_eq!(poll.options[1].vote_ratio, None);
    }

    #[test]
    fn deleted_and_removed_actions_name_the_gone_messages() {
        let res = json!({ "continuationContents": { "liveChatContinuation": {
            "actions": [
                { "markChatItemAsDeletedAction": { "targetItemId": "gone-1", "deletedStateMessage": { "runs": [] } } },
                { "removeChatItemAction": { "targetItemId": "gone-2" } }
            ]
        } } });
        let page = parse_live_chat_page(&res);
        assert_eq!(
            page.deleted,
            vec!["gone-1".to_string(), "gone-2".to_string()]
        );
        assert!(page.messages.is_empty());
    }

    #[test]
    fn a_response_without_the_new_fields_keeps_empty_defaults() {
        let raw = r#"{
            "messages": [],
            "continuation": null,
            "pollingIntervalMs": 2000,
            "isReplay": false
        }"#;
        let response: LiveChatResponse = serde_json::from_str(raw).unwrap();
        assert!(response.pinned_message.is_none());
        assert!(response.poll.is_none());
        assert!(response.deleted_message_ids.is_empty());
    }
}
