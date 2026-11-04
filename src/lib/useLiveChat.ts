import { useEffect } from "react";
import { useChatEngine, useChatState, useChatStore } from "../store/useChatStore";
import type { ChatView, LiveChatState } from "../store/useChatStore";

export type { ChatView, ChatViewTokens, LiveChatState } from "../store/useChatStore";

/**
 * Thin wrapper over the shared chat engine store, kept so existing callers and the
 * sidebar panel behave exactly as before. The poller itself lives in useChatStore,
 * where the floating overlay reads the same single engine.
 */
export function useLiveChat(videoId: string | undefined, enabled: boolean, view: ChatView = "top"): LiveChatState {
  const state = useChatState();

  useChatEngine(enabled && videoId ? videoId : null, false);

  useEffect(() => {
    if (!videoId || !enabled) return;
    // The store owns the view; mirror the caller's choice into it.
    useChatStore.getState().setView(view);
  }, [videoId, enabled, view]);

  return enabled && videoId ? state : { ...state, loading: false };
}
