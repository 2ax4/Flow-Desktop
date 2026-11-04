import { create } from "zustand";
import { useEffect } from "react";
import { getLiveChat } from "../lib/api/youtube";
import { isSeek, mergeReplay, needsMore, replayedBy } from "../lib/chatReplay";
import { parseStringList } from "../lib/chatOverlayLogic";
import { SETTINGS } from "../lib/settings/schema";
import type { SettingKey } from "../lib/settings/schema";
import { useAppSettingsStore } from "./useAppSettingsStore";
import { usePlayerStore } from "./usePlayerStore";
import type { LiveChatMessage, LiveChatPoll } from "../types/video";
import type { ChatAlertsOptions } from "../lib/audio/chatAlerts";

/** "Top chat", YouTube's filtered default, or every message. */
export type ChatView = "top" | "all";

export interface ChatViewTokens {
  top: string | null;
  all: string | null;
}

export interface LiveChatState {
  messages: LiveChatMessage[];
  loading: boolean;
  // Chat is unavailable for this video, or its stream has closed.
  ended: boolean;
  /** The chat offered both views, so `view` can switch between them. */
  canSwitchView: boolean;
  reconnect: () => void;
}

const MAX_MESSAGES = 400;
const MAX_SEEN_IDS = 1500;
const RETRY_MS = 3000;
const MAX_RETRY_MS = 30000;
const MAX_FAILURES = 6;
const MAX_RESEEDS = 3;
const MIN_POLL_MS = 800;
// Half-second replay steps, like useChatReplay: fine enough for chat, no per-frame renders.
const REPLAY_TICK_MS = 500;

interface ChatEnginePatch {
  messages?: LiveChatMessage[];
  loading?: boolean;
  ended?: boolean;
  canSwitchView?: boolean;
  error?: string | null;
  pinnedMessage?: LiveChatMessage | null;
  poll?: LiveChatPoll | null;
}

function alertOptions(): ChatAlertsOptions {
  const values = useAppSettingsStore.getState().values;
  const flag = (key: SettingKey, fallback: boolean) =>
    values[key] === undefined ? fallback : values[key] === "true";
  return {
    soundSuperChat: flag(SETTINGS.CHAT_ALERTS_SOUND_SUPERCHAT, true),
    soundHighlight: flag(SETTINGS.CHAT_ALERTS_SOUND_HIGHLIGHT, false),
    ttsSuperChat: flag(SETTINGS.CHAT_ALERTS_TTS_SUPERCHAT, false),
    ttsHighlight: flag(SETTINGS.CHAT_ALERTS_TTS_HIGHLIGHT, false),
    highlightKeywords: parseStringList(values[SETTINGS.CHAT_OVERLAY_HIGHLIGHT_KEYWORDS]),
    muted: useChatStore.getState().alertsMuted,
  };
}

/**
 * One poller per video, shared by the sidebar panel and the floating overlay so both can
 * never double-poll. Live mode walks YouTube's continuation chain (re-seeding on gaps);
 * replay mode pages ahead of the playhead the way useChatReplay does, driven by a ticker
 * reading the player clock instead of a hook subscription.
 */
class ChatEngine {
  readonly videoId: string;
  readonly isReplay: boolean;
  running = false;

  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private viewTokens: ChatViewTokens = { top: null, all: null };

  // Live state.
  private seen = new Set<string>();
  private continuation: string | null = null;
  private failures = 0;
  private reseeds = 0;

  // Replay state.
  private replayBuffer: LiveChatMessage[] = [];
  private replayContinuation: string | null = null;
  private seekContinuation: string | null = null;
  private fetchingGeneration: number | null = null;
  private retryAt = 0;
  private lastMs: number | null = null;

  constructor(videoId: string, isReplay: boolean) {
    this.videoId = videoId;
    this.isReplay = isReplay;
  }

  private patch(partial: ChatEnginePatch) {
    useChatStore.setState(partial);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    if (this.isReplay) {
      // Replays restart from the playhead; a resume deliberately shows a fresh page.
      this.replayBuffer = [];
      this.replayContinuation = null;
      this.lastMs = this.currentPlayerMs();
      this.patch({ loading: true, ended: false, messages: [] });
      this.fetchReplay(this.viewToken());
      if (this.replayTimer) clearInterval(this.replayTimer);
      this.replayTimer = setInterval(() => this.tickReplay(), REPLAY_TICK_MS);
    } else {
      this.failures = 0;
      this.reseeds = 0;
      this.continuation = this.viewToken();
      this.patch({ loading: true, ended: false, error: null });
      this.scheduleLive(0);
    }
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimer();
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    this.patch({ loading: false });
  }

  private viewToken(): string | null {
    return useChatStore.getState().view === "all" ? this.viewTokens.all : null;
  }

  // --- Live polling (ported from useLiveChat) ---

  private scheduleLive(delay: number) {
    this.clearTimer();
    this.timer = setTimeout(() => void this.pollLive(), delay);
  }

  private async pollLive() {
    if (!this.running || this.isReplay) return;
    const generation = this.generation;
    try {
      const page = await getLiveChat(this.videoId, this.continuation);
      if (!this.running || generation !== this.generation) return;
      this.patch({ loading: false });
      if (page.topChatContinuation || page.allChatContinuation) {
        this.viewTokens = {
          top: page.topChatContinuation ?? this.viewTokens.top,
          all: page.allChatContinuation ?? this.viewTokens.all,
        };
        this.patch({ canSwitchView: Boolean(this.viewTokens.all) });
      }

      this.ingest(page.messages);

      if ("pinnedMessage" in page) this.patch({ pinnedMessage: page.pinnedMessage ?? null });
      if (page.poll !== undefined) this.patch({ poll: page.poll ?? null });
      if (page.deletedMessageIds?.length) useChatStore.getState().applyDeleted(page.deletedMessageIds);

      if (!page.continuation) {
        if (this.reseeds >= MAX_RESEEDS) {
          this.patch({ ended: true, loading: false });
          return;
        }
        this.reseeds += 1;
        this.continuation = this.viewToken();
        this.scheduleLive(RETRY_MS);
        return;
      }

      this.failures = 0;
      this.reseeds = 0;
      this.continuation = page.continuation;
      this.scheduleLive(Math.max(MIN_POLL_MS, page.pollingIntervalMs || 2000));
    } catch (err) {
      if (!this.running || generation !== this.generation) return;
      this.failures += 1;
      console.warn("Live chat poll failed", err);
      if (this.failures >= MAX_FAILURES) {
        this.patch({ loading: false, ended: true, error: "poll_failed" });
        return;
      }
      // Backing off matters: YouTube throttles a chat that hammers it.
      this.scheduleLive(Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (this.failures - 1)));
    }
  }

  private ingest(incoming: LiveChatMessage[]) {
    const fresh = incoming.filter((message) => !this.seen.has(message.id));
    if (fresh.length === 0) return;
    for (const message of fresh) this.seen.add(message.id);
    if (this.seen.size > MAX_SEEN_IDS) {
      this.seen = new Set(Array.from(this.seen).slice(-MAX_SEEN_IDS));
    }
    const { messages, deletedIds } = useChatStore.getState();
    const added = deletedIds.size ? fresh.filter((message) => !deletedIds.has(message.id)) : fresh;
    if (added.length === 0) return;
    const next = [...messages, ...added];
    this.patch({ messages: next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next });
    void this.fireAlerts(added);
  }

  // Alerts only fire for live chat; a replay would ding for every past Super Chat.
  private async fireAlerts(added: LiveChatMessage[]) {
    try {
      const { fireChatAlerts } = await import("../lib/audio/chatAlerts");
      await fireChatAlerts(added, alertOptions());
    } catch {
      // Alerts are best-effort.
    }
  }

  // --- Replay (ported from useChatReplay) ---

  private currentPlayerMs(): number {
    return Math.floor(usePlayerStore.getState().currentTime * 2) * 500;
  }

  private tickReplay() {
    if (!this.running || !this.isReplay) return;
    const nowMs = this.currentPlayerMs();
    const previous = this.lastMs;
    this.lastMs = nowMs;
    if (isSeek(previous, nowMs)) {
      // The seek token resumes the same view at the new position.
      this.generation += 1;
      this.replayContinuation = null;
      this.fetchReplay(this.seekContinuation ?? this.viewToken());
      this.showReplayUpTo(nowMs);
      return;
    }
    this.showReplayUpTo(nowMs);
    const continuation = this.replayContinuation;
    if (
      continuation &&
      this.fetchingGeneration !== this.generation &&
      Date.now() >= this.retryAt &&
      needsMore(this.replayBuffer, nowMs)
    ) {
      this.fetchReplay(continuation);
    }
  }

  private fetchReplay(token: string | null) {
    if (!this.videoId || !this.running) return;
    const generation = this.generation;
    this.fetchingGeneration = generation;
    getLiveChat(this.videoId, token, usePlayerStore.getState().currentTime * 1000)
      .then((page) => {
        if (!this.running || generation !== this.generation) return;
        this.replayBuffer = mergeReplay(this.replayBuffer, page.messages, this.lastMs ?? 0);
        this.replayContinuation = page.continuation ?? null;
        this.seekContinuation = page.seekContinuation ?? this.seekContinuation;
        if (page.topChatContinuation || page.allChatContinuation) {
          this.viewTokens = {
            top: page.topChatContinuation ?? this.viewTokens.top,
            all: page.allChatContinuation ?? this.viewTokens.all,
          };
          this.patch({ canSwitchView: Boolean(this.viewTokens.all) });
        }
        const patch: ChatEnginePatch = {
          ended: !page.continuation && this.replayBuffer.length === 0,
          loading: false,
        };
        if ("pinnedMessage" in page) patch.pinnedMessage = page.pinnedMessage ?? null;
        if (page.poll !== undefined) patch.poll = page.poll ?? null;
        if (page.deletedMessageIds?.length) useChatStore.getState().applyDeleted(page.deletedMessageIds);
        this.patch(patch);
        this.showReplayUpTo(this.lastMs ?? 0);
      })
      .catch((error) => {
        if (!this.running || generation !== this.generation) return;
        console.warn("Chat replay request failed", error);
        this.retryAt = Date.now() + RETRY_MS;
        this.patch({ loading: false, error: "replay_failed" });
      })
      .finally(() => {
        if (generation === this.generation) this.fetchingGeneration = null;
      });
  }

  private showReplayUpTo(nowMs: number) {
    const next = replayedBy(this.replayBuffer, nowMs);
    const current = useChatStore.getState().messages;
    if (current.length === next.length && current[current.length - 1]?.id === next[next.length - 1]?.id) return;
    useChatStore.setState({ messages: next });
  }

  // A view switch restarts the same conversation from the other stream (kept tokens).
  setView(view: ChatView) {
    if (useChatStore.getState().view === view) return;
    useChatStore.setState({ view });
    if (!this.running) return;
    this.generation += 1;
    if (this.isReplay) {
      this.replayBuffer = [];
      this.replayContinuation = null;
      this.lastMs = this.currentPlayerMs();
      this.patch({ messages: [], loading: true, ended: false });
      this.fetchReplay(this.viewToken());
    } else {
      this.seen = new Set();
      this.failures = 0;
      this.reseeds = 0;
      this.continuation = this.viewToken();
      this.patch({ messages: [], loading: true, ended: false, error: null });
      this.scheduleLive(0);
    }
  }

  // Reconnect resumes the conversation; the backlog and seen-set survive.
  reconnect() {
    if (!this.running) {
      this.start();
      return;
    }
    this.generation += 1;
    this.failures = 0;
    this.reseeds = 0;
    if (this.isReplay) {
      this.replayBuffer = [];
      this.replayContinuation = null;
      this.lastMs = this.currentPlayerMs();
      this.patch({ messages: [], loading: true, ended: false });
      this.fetchReplay(this.viewToken());
      return;
    }
    this.continuation = this.viewToken();
    this.patch({ loading: true, ended: false, error: null });
    this.scheduleLive(0);
  }
}

let engine: ChatEngine | null = null;
let refcount = 0;

interface ChatStoreState {
  messages: LiveChatMessage[];
  loading: boolean;
  ended: boolean;
  canSwitchView: boolean;
  /** Machine code of the last engine failure ("poll_failed", "replay_failed"). */
  error: string | null;
  view: ChatView;
  pinnedMessage: LiveChatMessage | null;
  poll: LiveChatPoll | null;
  deletedIds: Set<string>;
  /** Session-wide mute for all chat alert sounds and speech. */
  alertsMuted: boolean;
  videoId: string | null;
  isReplay: boolean;
  /** Refcounted start; every mounted consumer pairs it with releaseEngine. */
  ensureEngine: (videoId: string, isReplay: boolean) => void;
  releaseEngine: () => void;
  setView: (view: ChatView) => void;
  applyDeleted: (ids: string[]) => void;
  reconnect: () => void;
  clear: () => void;
  setAlertsMuted: (muted: boolean) => void;
}

export const useChatStore = create<ChatStoreState>((set) => ({
  messages: [],
  loading: false,
  ended: false,
  canSwitchView: false,
  error: null,
  view: "top",
  pinnedMessage: null,
  poll: null,
  deletedIds: new Set<string>(),
  alertsMuted: false,
  videoId: null,
  isReplay: false,

  ensureEngine: (videoId, isReplay) => {
    refcount += 1;
    if (engine && engine.videoId === videoId && engine.isReplay === isReplay) {
      engine.start();
      set({ videoId, isReplay });
      return;
    }
    engine?.stop();
    set({
      messages: [],
      loading: false,
      ended: false,
      canSwitchView: false,
      error: null,
      pinnedMessage: null,
      poll: null,
      deletedIds: new Set<string>(),
      videoId,
      isReplay,
    });
    engine = new ChatEngine(videoId, isReplay);
    engine.start();
  },

  releaseEngine: () => {
    refcount = Math.max(0, refcount - 1);
    if (refcount === 0) engine?.stop();
  },

  setView: (view) => engine?.setView(view),
  applyDeleted: (ids) => {
    if (!ids.length) return;
    set((state) => {
      const deletedIds = new Set(state.deletedIds);
      for (const id of ids) deletedIds.add(id);
      return {
        deletedIds,
        messages: state.messages.filter((message) => !deletedIds.has(message.id)),
        pinnedMessage: state.pinnedMessage && deletedIds.has(state.pinnedMessage.id) ? null : state.pinnedMessage,
      };
    });
  },
  reconnect: () => engine?.reconnect(),
  clear: () => {
    engine?.stop();
    engine = null;
    refcount = 0;
    set({
      messages: [],
      loading: false,
      ended: false,
      canSwitchView: false,
      error: null,
      pinnedMessage: null,
      poll: null,
      deletedIds: new Set<string>(),
      videoId: null,
      isReplay: false,
    });
  },
  setAlertsMuted: (alertsMuted) => set({ alertsMuted }),
}));

/** Mount/unmount the shared engine alongside a component that reads chat from the store. */
export function useChatEngine(videoId: string | null, isReplay: boolean) {
  const ensureEngine = useChatStore((s) => s.ensureEngine);
  useEffect(() => {
    if (!videoId) return;
    ensureEngine(videoId, isReplay);
    return () => useChatStore.getState().releaseEngine();
  }, [ensureEngine, videoId, isReplay]);
}

/** The LiveChatState shape sidebar consumers expect, now sourced from the shared store. */
export function useChatState(): LiveChatState {
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const ended = useChatStore((s) => s.ended);
  const canSwitchView = useChatStore((s) => s.canSwitchView);
  const reconnect = useChatStore((s) => s.reconnect);
  return { messages, loading, ended, canSwitchView, reconnect };
}
