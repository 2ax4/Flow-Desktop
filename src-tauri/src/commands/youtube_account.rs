use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

use crate::errors::{AppError, ErrorResponse};
use crate::models::youtube_account::{SendChatOutcome, YouTubeAccountInfo};
use crate::security::validation::{validate_channel_id, validate_video_id};
use crate::services::youtube_account::{
    LOGIN_WINDOW_LABEL, YOUTUBE_ORIGIN, YouTubeAccountService, emit_state, spawn_login_watch,
};

/// Opens the YouTube sign-in window, or focuses the one already open. Its
/// cookies are watched in the background and captured once the user signs in.
#[tauri::command]
pub async fn youtube_login_start<R: Runtime>(app: AppHandle<R>) -> Result<(), ErrorResponse> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let url = tauri::Url::parse(YOUTUBE_ORIGIN).map_err(|error| {
        ErrorResponse::from(AppError::Internal(format!(
            "Bad YouTube login URL: {error}"
        )))
    })?;
    let mut builder =
        WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
            .title("Sign in to YouTube")
            .inner_size(440.0, 640.0)
            .resizable(true);

    // WebView2 shares one environment per user-data folder (see `webview2`).
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(crate::webview2::BROWSER_ARGS);
    }

    let window = builder.build().map_err(|error| {
        ErrorResponse::from(AppError::Internal(format!(
            "Failed to open the YouTube login window: {error}"
        )))
    })?;

    #[cfg(target_os = "linux")]
    crate::web_process::watch(&window);

    spawn_login_watch(app);
    tracing::info!("youtube_login_window_opened");
    Ok(())
}

/// Whether a YouTube session is stored, and the channel behind it.
#[tauri::command]
pub async fn youtube_login_status(
    account: State<'_, YouTubeAccountService>,
) -> Result<YouTubeAccountInfo, ErrorResponse> {
    Ok(account.status().await)
}

/// Forgets the stored YouTube session.
#[tauri::command]
pub async fn youtube_logout<R: Runtime>(
    app: AppHandle<R>,
    account: State<'_, YouTubeAccountService>,
) -> Result<(), ErrorResponse> {
    account
        .delete_cookies()
        .await
        .map_err(ErrorResponse::from)?;
    emit_state(&app, YouTubeAccountInfo::default());
    Ok(())
}

/// Sends one live chat message as the signed-in account.
#[tauri::command]
pub async fn send_live_chat(
    video_id: String,
    channel_id: String,
    text: String,
    account: State<'_, YouTubeAccountService>,
) -> Result<SendChatOutcome, ErrorResponse> {
    validate_video_id(&video_id).map_err(ErrorResponse::from)?;
    validate_channel_id(&channel_id).map_err(ErrorResponse::from)?;
    let text = text.trim();
    if text.is_empty() {
        return Err(ErrorResponse::from(AppError::Validation(
            "Message cannot be empty".into(),
        )));
    }
    if text.chars().count() > 200 {
        return Err(ErrorResponse::from(AppError::Validation(
            "Message cannot exceed 200 characters".into(),
        )));
    }

    account
        .send_live_chat(&video_id, &channel_id, text)
        .await
        .map_err(ErrorResponse::from)
}
