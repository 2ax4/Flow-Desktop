import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeBackend } from "./errors";

export interface YouTubeAccountState {
  signedIn: boolean;
  channelName: string | null;
  channelId: string | null;
  photoUrl: string | null;
}

export const ANONYMOUS_ACCOUNT: YouTubeAccountState = {
  signedIn: false,
  channelName: null,
  channelId: null,
  photoUrl: null,
};

export interface SendLiveChatResult {
  ok: boolean;
  errorKind: string | null;
  errorMessage: string | null;
  messageId: string | null;
}

export const getYouTubeLoginStatus = () => invokeBackend<YouTubeAccountState>("youtube_login_status");
/** Opens the sign-in window the backend owns. */
export const startYouTubeLogin = () => invokeBackend<void>("youtube_login_start");
export const youtubeLogout = () => invokeBackend<void>("youtube_logout");

export const sendLiveChat = (videoId: string, channelId: string | null, text: string) =>
  invokeBackend<SendLiveChatResult>("send_live_chat", { videoId, channelId, text });

export const onYouTubeAccount = (handler: (account: YouTubeAccountState) => void): Promise<UnlistenFn> =>
  listen<YouTubeAccountState>("yt-account://state", (event) => handler(event.payload));
