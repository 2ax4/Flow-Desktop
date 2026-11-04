import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { motion } from "framer-motion";
import {
  ArrowDown,
  BarChart3,
  Loader2,
  Lock,
  LockOpen,
  Pin,
  RotateCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { getString } from "../../lib/i18n/index";
import { SETTINGS } from "../../lib/settings/schema";
import { setSettingValue, useAppSettingsStore } from "../../store/useAppSettingsStore";
import { useChatEngine, useChatStore } from "../../store/useChatStore";
import { usePlayerStore } from "../../store/usePlayerStore";
import { useYouTubeAccountStore } from "../../store/useYouTubeAccountStore";
import { sendLiveChat, startYouTubeLogin } from "../../lib/api/youtubeAccount";
import { getBackendErrorMessage } from "../../lib/api/errors";
import { useProxyImageSrc } from "../../lib/useImageProxy";
import {
  argbToCss,
  authorColor,
  clampOverlayGeometry,
  clampOverlayPlacement,
  mergeDuplicates,
  parseOverlayGeometry,
  parseStringList,
  prefersDarkText,
  toOverlayMessages,
  type OverlayGeometry,
} from "../../lib/chatOverlayLogic";
import type { LiveChatMessage, LiveChatSegment } from "../../types/video";
import { ChatOverlaySettings } from "./ChatOverlaySettings";
import { ChatOverlayAnalytics } from "./ChatOverlayAnalytics";

const MIN_WIDTH_PX = 200;
const MIN_HEIGHT_PX = 160;
const IDLE_FADE_MS = 8000;
const FADED_OPACITY = 0.35;

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

interface ChatOverlayProps {
  isReplay?: boolean;
  onClose: () => void;
}

type PopupKind = "settings" | "analytics" | null;

export function ChatOverlay({ isReplay = false, onClose }: ChatOverlayProps) {
  const videoId = usePlayerStore((s) => s.currentVideo?.id ?? null);
  const channelId =
    usePlayerStore((s) => s.watchPageCache?.videoDetails?.channelId ?? s.currentVideo?.channelId ?? null) ?? null;

  // One poller for the overlay and the sidebar panel alike.
  useChatEngine(videoId, isReplay);

  const locked = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_LOCKED] === "true");
  const fadeIdle = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_FADE_IDLE] !== "false");
  const fontSize = useAppSettingsStore((s) => Number(s.values[SETTINGS.CHAT_OVERLAY_FONT_SIZE] ?? 14));
  const opacity = useAppSettingsStore((s) => Number(s.values[SETTINGS.CHAT_OVERLAY_OPACITY] ?? 80));
  const bubbles = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_BUBBLES] !== "false");
  const avatars = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_AVATARS] !== "false");
  const badges = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_BADGES] !== "false");
  const lifetimeSeconds = useAppSettingsStore((s) => Number(s.values[SETTINGS.CHAT_OVERLAY_MESSAGE_LIFETIME] ?? 0));
  const maxMessages = useAppSettingsStore((s) => Number(s.values[SETTINGS.CHAT_OVERLAY_MAX_MESSAGES] ?? 18));
  const mergeSetting = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_MERGE_DUPLICATES] !== "false");
  const keywords = useAppSettingsStore((s) => parseStringList(s.values[SETTINGS.CHAT_OVERLAY_HIGHLIGHT_KEYWORDS]));
  const filteredWords = useAppSettingsStore((s) => parseStringList(s.values[SETTINGS.CHAT_OVERLAY_FILTERED_WORDS]));
  const blockedUsers = useAppSettingsStore((s) => parseStringList(s.values[SETTINGS.CHAT_OVERLAY_BLOCKED_USERS]));
  const emojiSpamFilter = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_EMOJI_SPAM_FILTER] === "true");
  const geometrySetting = useAppSettingsStore((s) => s.values[SETTINGS.CHAT_OVERLAY_GEOMETRY]);

  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const ended = useChatStore((s) => s.ended);
  const error = useChatStore((s) => s.error);
  const pinnedMessage = useChatStore((s) => s.pinnedMessage);
  const poll = useChatStore((s) => s.poll);
  const alertsMuted = useChatStore((s) => s.alertsMuted);
  const setAlertsMuted = useChatStore((s) => s.setAlertsMuted);
  const reconnect = useChatStore((s) => s.reconnect);

  const [geometry, setGeometry] = useState<OverlayGeometry>(() => parseOverlayGeometry(geometrySetting));
  const [popup, setPopup] = useState<PopupKind>(null);
  const [faded, setFaded] = useState(false);
  const [pinnedDismissedId, setPinnedDismissedId] = useState<string | null>(null);
  const [jumpPinned, setJumpPinned] = useState(true);

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef(geometry);
  const interactingRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const sessionLogRef = useRef<LiveChatMessage[]>([]);
  const sessionSeenIdsRef = useRef<Set<string>>(new Set());
  const sessionStartRef = useRef(Date.now());
  geometryRef.current = geometry;

  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setFaded(false);
  }, []);

  // Measure the media wrapper the panel floats in.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const container = panelRef.current?.parentElement;
    if (!container) return;
    const measure = () =>
      setContainerSize((current) =>
        current.width === container.clientWidth && current.height === container.clientHeight
          ? current
          : { width: container.clientWidth, height: container.clientHeight },
      );
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, []);

  // Adopt geometry saved elsewhere (a second window, a fresh setting) unless a gesture is live.
  useEffect(() => {
    if (interactingRef.current) return;
    setGeometry(parseOverlayGeometry(geometrySetting));
  }, [geometrySetting]);

  // Idle fade: quiet pointer and chat for a while, then dim; any activity restores.
  useEffect(() => {
    if (!fadeIdle) {
      setFaded(false);
      return;
    }
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current > IDLE_FADE_MS) setFaded(true);
    }, 1000);
    return () => clearInterval(interval);
  }, [fadeIdle]);

  // Session log for analytics, and a new message counts as panel activity.
  useEffect(() => {
    let added = false;
    for (const message of messages) {
      if (sessionSeenIdsRef.current.has(message.id)) continue;
      sessionSeenIdsRef.current.add(message.id);
      sessionLogRef.current.push(message);
      added = true;
    }
    if (added) bumpActivity();
  }, [messages, bumpActivity]);

  // Keep glued to the newest message unless the user scrolled up.
  useLayoutEffect(() => {
    if (jumpPinned && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, jumpPinned]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const onScroll = () => {
      setJumpPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
    };
    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    void useYouTubeAccountStore.getState().initialize();
  }, []);

  const filtered = useMemo(
    () => toOverlayMessages(messages, { keywords, filteredWords, blockedUsers, emojiSpamFilter }),
    [messages, keywords, filteredWords, blockedUsers, emojiSpamFilter],
  );
  const visible = useMemo(() => filtered.slice(-maxMessages), [filtered, maxMessages]);
  const rows = useMemo(() => {
    if (!mergeSetting) return visible.map((entry) => ({ ...entry, count: 1 }));
    const merged = mergeDuplicates(visible.map((entry) => entry.message));
    return merged.map((row) => ({
      message: row.message,
      count: row.count,
      highlighted: visible.find((entry) => entry.message.id === row.message.id)?.highlighted ?? false,
    }));
  }, [visible, mergeSetting]);

  // --- Drag + resize (ratio geometry, persisted on pointerup) ---
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: OverlayGeometry;
    mode: "move" | "resize";
  } | null>(null);

  const beginGesture = (mode: "move" | "resize") => (event: React.PointerEvent<HTMLDivElement>) => {
    if (locked || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-drag-ignore='true']")) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: geometryRef.current,
      mode,
    };
    interactingRef.current = true;
    bumpActivity();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Headless/test environments may lack pointer capture.
    }
  };

  const onGestureMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const width = containerSize.width || panelRef.current?.parentElement?.clientWidth || 1;
    const height = containerSize.height || panelRef.current?.parentElement?.clientHeight || 1;
    const dx = (event.clientX - gesture.startX) / width;
    const dy = (event.clientY - gesture.startY) / height;
    if (gesture.mode === "move") {
      setGeometry(
        clampOverlayPlacement(
          {
            ...gesture.origin,
            leftRatio: gesture.origin.leftRatio + dx,
            topRatio: gesture.origin.topRatio + dy,
          },
          width,
          height,
        ),
      );
      return;
    }
    const minWidth = Math.max(MIN_WIDTH_PX / width, 0.05);
    const minHeight = Math.max(MIN_HEIGHT_PX / height, 0.05);
    setGeometry({
      ...gesture.origin,
      widthRatio: clamp(gesture.origin.widthRatio + dx, minWidth, 1 - gesture.origin.leftRatio),
      heightRatio: clamp(gesture.origin.heightRatio + dy, minHeight, 1 - gesture.origin.topRatio),
    });
  };

  const endGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    interactingRef.current = false;
    const finalGeometry = clampOverlayGeometry(geometryRef.current);
    setGeometry(finalGeometry);
    void setSettingValue(SETTINGS.CHAT_OVERLAY_GEOMETRY, JSON.stringify(finalGeometry));
  };

  const toggleLock = () => {
    void setSettingValue(SETTINGS.CHAT_OVERLAY_LOCKED, String(!locked));
  };

  const headerButtonClass =
    "grid h-6 w-6 place-items-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white";

  const showPinnedBar = pinnedMessage && pinnedMessage.id !== pinnedDismissedId;

  return (
    <motion.div
      ref={panelRef}
      role="complementary"
      aria-label={getString("chat_overlay_title")}
      className="absolute z-20 flex flex-col overflow-hidden rounded-xl border border-white/15 text-white shadow-2xl"
      style={{
        left: `${geometry.leftRatio * 100}%`,
        top: `${geometry.topRatio * 100}%`,
        width: `${geometry.widthRatio * 100}%`,
        height: `${geometry.heightRatio * 100}%`,
        backgroundColor: `rgba(0, 0, 0, ${opacity / 100})`,
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: faded ? FADED_OPACITY : 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      onPointerMove={bumpActivity}
      onPointerDown={bumpActivity}
      onPointerMoveCapture={onGestureMove}
      onPointerUpCapture={endGesture}
      onPointerCancelCapture={endGesture}
    >
      {/* Header: drag surface + controls */}
      <div
        className={cx(
          "flex h-8 shrink-0 items-center gap-1.5 px-2 touch-none",
          locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={beginGesture("move")}
        onDoubleClick={toggleLock}
      >
        <span
          className={cx(
            "flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-white/85 select-none",
          )}
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
          {getString("chat_overlay_title")}
        </span>
        <div className="ml-auto flex items-center gap-0.5" data-drag-ignore="true">
          <button
            type="button"
            title={getString(locked ? "chat_overlay_locked" : "chat_overlay_unlocked")}
            aria-label={getString(locked ? "chat_overlay_locked" : "chat_overlay_unlocked")}
            aria-pressed={locked}
            onClick={toggleLock}
            className={headerButtonClass}
          >
            {locked ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>
          <button
            type="button"
            title={getString("chat_overlay_settings")}
            aria-label={getString("chat_overlay_settings")}
            aria-expanded={popup === "settings"}
            onClick={() => setPopup((current) => (current === "settings" ? null : "settings"))}
            className={cx(headerButtonClass, popup === "settings" && "bg-white/15 text-white")}
          >
            <SlidersHorizontal size={14} />
          </button>
          <button
            type="button"
            title={getString("chat_overlay_analytics")}
            aria-label={getString("chat_overlay_analytics")}
            aria-expanded={popup === "analytics"}
            onClick={() => setPopup((current) => (current === "analytics" ? null : "analytics"))}
            className={cx(headerButtonClass, popup === "analytics" && "bg-white/15 text-white")}
          >
            <BarChart3 size={14} />
          </button>
          <button
            type="button"
            title={getString("chat_alerts_mute")}
            aria-label={getString("chat_alerts_mute")}
            aria-pressed={alertsMuted}
            onClick={() => setAlertsMuted(!alertsMuted)}
            className={headerButtonClass}
          >
            {alertsMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button
            type="button"
            title={getString("chat_overlay_close")}
            aria-label={getString("chat_overlay_close")}
            onClick={onClose}
            className={headerButtonClass}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {popup === "settings" && (
        <ChatOverlaySettings onClose={() => setPopup(null)} />
      )}
      {popup === "analytics" && (
        <ChatOverlayAnalytics
          messages={sessionLogRef.current}
          sessionStartMs={sessionStartRef.current}
          onClose={() => setPopup(null)}
        />
      )}

      {/* Pinned message bar */}
      {showPinnedBar && pinnedMessage && (
        <div className="mx-2 mb-1.5 flex shrink-0 items-start gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1.5">
          <Pin size={12} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
          <p className="min-w-0 flex-1 break-words text-xs leading-snug text-white/90">
            <span className="mr-1.5 font-semibold text-amber-300">{pinnedMessage.author}</span>
            <MessageBody segments={pinnedMessage.segments} message={pinnedMessage.message} />
          </p>
          <button
            type="button"
            aria-label={getString("chat_overlay_close")}
            onClick={() => setPinnedDismissedId(pinnedMessage.id)}
            className="shrink-0 rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Poll card (display-only) */}
      {poll && (
        <div className="mx-2 mb-1.5 shrink-0 rounded-lg border border-white/10 bg-white/[0.06] p-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-sky-300">
            {getString("chat_overlay_poll_title")}
          </p>
          <p className="mt-0.5 text-[13px] font-semibold leading-snug text-white/95">{poll.question}</p>
          <div className="mt-1.5 space-y-1">
            {poll.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled
                title={getString("chat_overlay_poll_vote_unsupported")}
                aria-disabled="true"
                className="relative block w-full overflow-hidden rounded bg-white/5 px-2 py-1 text-left text-xs text-white/85 disabled:cursor-not-allowed hover:bg-white/10"
              >
                {typeof option.voteRatio === "number" && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-white/15"
                    style={{ width: `${Math.round(clamp(option.voteRatio, 0, 1) * 100)}%` }}
                  />
                )}
                <span className="relative">{option.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message list */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          className="hide-scrollbar h-full space-y-1 overflow-y-auto px-2 py-1"
          style={{ fontSize: `${fontSize}px` }}
        >
          {loading && messages.length === 0 ? (
            <div className="flex items-center gap-2 py-2 text-white/50">
              <Loader2 size={14} className="animate-spin" />
              {getString("chat_overlay_connecting")}
            </div>
          ) : messages.length === 0 ? (
            <div className="py-2 text-white/50">
              <p>{getString("chat_overlay_empty")}</p>
              {(ended || error) && (
                <button
                  type="button"
                  onClick={reconnect}
                  className="mt-1 flex items-center gap-1.5 rounded-full px-1.5 py-1 text-xs font-semibold text-white/80 hover:bg-white/10"
                >
                  <RotateCw size={12} />
                  {getString("live_chat_reconnect")}
                </button>
              )}
            </div>
          ) : (
            rows.map((row) => (
              <ExpiringRow key={row.message.id} lifetimeSeconds={lifetimeSeconds}>
                <OverlayChatRow
                  row={row}
                  bubbles={bubbles}
                  avatars={avatars}
                  badges={badges}
                />
              </ExpiringRow>
            ))
          )}
          {ended && messages.length > 0 && (
            <p className="px-1 py-1 text-xs text-white/45">{getString("live_chat_ended")}</p>
          )}
        </div>

        {!jumpPinned && (
          <button
            type="button"
            onClick={() => setJumpPinned(true)}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/25"
          >
            <ArrowDown size={12} />
            {getString("chat_overlay_jump_latest")}
          </button>
        )}
      </div>

      {/* Footer input: live only */}
      {!isReplay && (
        <ChatOverlayFooter videoId={videoId} channelId={channelId} />
      )}

      {/* Resize handle */}
      {!locked && (
        <div
          onPointerDown={beginGesture("resize")}
          data-drag-ignore="true"
          role="presentation"
          className="absolute bottom-0 right-0 z-30 h-4 w-4 cursor-nwse-resize touch-none"
        >
          <div className="absolute bottom-1 right-1 h-2 w-2 rounded-sm border-b-2 border-r-2 border-white/40" />
        </div>
      )}
    </motion.div>
  );
}

/** Drops a row once its lifetime elapses; 0 means forever. */
function ExpiringRow({ lifetimeSeconds, children }: { lifetimeSeconds: number; children: React.ReactNode }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (lifetimeSeconds <= 0) return;
    const timer = setTimeout(() => setExpired(true), lifetimeSeconds * 1000);
    return () => clearTimeout(timer);
  }, [lifetimeSeconds]);
  if (expired) return null;
  return <>{children}</>;
}

function MessageBody({ segments, message }: { segments: LiveChatSegment[]; message: string }) {
  const toSrc = useProxyImageSrc();
  if (!segments?.length) return <>{message}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.emojiImageUrl ? (
          <img
            key={index}
            src={toSrc(segment.emojiImageUrl)}
            alt={segment.text}
            className="inline-block h-[1.15em] w-[1.15em] align-text-bottom"
          />
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function authorNameColor(message: LiveChatMessage): string {
  if (message.isOwner) return "text-amber-400";
  if (message.isModerator) return "text-emerald-400";
  if (message.isVerified) return "text-sky-400";
  if (message.isMember) return "text-purple-400";
  return "";
}

function AuthorBadges({ message }: { message: LiveChatMessage }) {
  if (!message.isModerator && !message.isVerified && !message.isMember) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 align-middle" aria-hidden="true">
      {message.isModerator && <ShieldBadge />}
      {message.isVerified && <VerifiedBadge />}
      {message.isMember && <MemberBadge />}
    </span>
  );
}

function ShieldBadge() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 fill-emerald-400" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3z" />
    </svg>
  );
}

function VerifiedBadge() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 fill-sky-400" aria-hidden="true">
      <path d="M12 2l2.4 2.1 3.2-.4 1 3 2.9 1.3-1 3.1 1 3.1-2.9 1.3-1 3-3.2-.4L12 22l-2.4-2.1-3.2.4-1-3L2.5 16l1-3.1-1-3.1 2.9-1.3 1-3 3.2.4L12 2zm-1 13.4l5-5-1.4-1.4-3.6 3.6-1.8-1.8L7.8 12l3.2 3.4z" />
    </svg>
  );
}

function MemberBadge() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3 fill-purple-400" aria-hidden="true">
      <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8L12 2z" />
    </svg>
  );
}

interface OverlayChatRowProps {
  row: { message: LiveChatMessage; count: number; highlighted: boolean };
  bubbles: boolean;
  avatars: boolean;
  badges: boolean;
}

function OverlayChatRow({ row, bubbles, avatars, badges }: OverlayChatRowProps) {
  const toSrc = useProxyImageSrc();
  const { message, count, highlighted } = row;
  const nameColor = authorNameColor(message) || authorColor(message.author);
  const bubbleClass = bubbles ? "rounded-lg bg-white/10 px-2 py-1.5" : "px-0.5 py-0.5";
  const highlightClass = highlighted ? "ring-2 ring-amber-400/70 bg-amber-400/10" : "";

  if (message.messageType === "superChat") {
    const background = argbToCss(message.superChatArgb) ?? "rgba(245, 158, 11, 0.2)";
    const header = argbToCss(message.superChatHeaderArgb) ?? background;
    const darkText = prefersDarkText(message.superChatArgb);
    const textMain = darkText ? "text-black" : "text-white";
    return (
      <div className={`overflow-hidden rounded-lg ${highlightClass}`} style={{ backgroundColor: background }}>
        <div
          className={`flex items-center justify-between gap-2 px-2 py-1 text-xs font-bold ${textMain}`}
          style={{ backgroundColor: header }}
        >
          <span className="truncate">{message.author}</span>
          {message.superChatAmount && <span className="shrink-0">{message.superChatAmount}</span>}
        </div>
        {message.message && (
          <div className={`px-2 py-1 break-words ${textMain} opacity-90`}>
            <MessageBody segments={message.segments} message={message.message} />
          </div>
        )}
      </div>
    );
  }

  if (message.messageType === "membership") {
    return (
      <div className={`rounded-lg border-l-2 border-purple-400/60 bg-purple-400/10 px-2 py-1.5 ${highlightClass}`}>
        <div className="flex items-center gap-1.5 text-xs font-bold text-purple-300">
          <span className="truncate">{message.author}</span>
          <span className="rounded bg-purple-400/20 px-1 py-px text-[10px] uppercase tracking-wide">
            {getString("chat_overlay_member_chip")}
          </span>
          {badges && <AuthorBadges message={message} />}
        </div>
        {message.message && (
          <div className="mt-0.5 break-words text-white/90">
            <MessageBody segments={message.segments} message={message.message} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cx("flex gap-1.5", bubbleClass, bubbles && highlighted && highlightClass)}>
      {avatars && (
        message.authorPhotoUrl ? (
          <img
            src={toSrc(message.authorPhotoUrl)}
            alt=""
            className="mt-0.5 h-5 w-5 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-white/15" />
        )
      )}
      <p className="min-w-0 flex-1 break-words leading-snug text-white/95">
        <span className={cx("mr-1.5 inline-flex items-center gap-1 align-middle text-[0.85em] font-semibold", nameColor)}>
          {message.author}
          {badges && <AuthorBadges message={message} />}
        </span>
        <MessageBody segments={message.segments} message={message.message} />
        {count > 1 && (
          <span className="ml-1.5 inline-block rounded-full bg-white/15 px-1.5 align-middle text-[10px] font-bold text-white/80">
            x{count}
          </span>
        )}
      </p>
    </div>
  );
}

function ChatOverlayFooter({ videoId, channelId }: { videoId: string | null; channelId: string | null }) {
  const account = useYouTubeAccountStore((s) => s.account);
  const loaded = useYouTubeAccountStore((s) => s.loaded);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  if (!loaded) return null;

  const submit = async () => {
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed || sending || !videoId) return;
    setSending(true);
    setErrorText(null);
    try {
      const result = await sendLiveChat(videoId, channelId, trimmed);
      if (result.ok) {
        setText("");
      } else {
        setErrorText(sendErrorText(result.errorKind, result.errorMessage));
      }
    } catch (error) {
      setErrorText(getBackendErrorMessage(error) || getString("chat_send_error_rejected"));
    } finally {
      setSending(false);
    }
  };

  if (!account.signedIn) {
    return (
      <div className="shrink-0 border-t border-white/10 p-2">
        <button
          type="button"
          onClick={() => void startYouTubeLogin()}
          className="w-full rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/25"
        >
          {getString("chat_overlay_sign_in")}
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-white/10 p-2">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={text}
          maxLength={200}
          placeholder={getString("chat_send_placeholder")}
          aria-label={getString("chat_send_placeholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
          }}
          className="min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-white outline-none placeholder:text-white/40 focus:border-white/40"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={sending || text.trim().length === 0}
          className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-white/15 px-3 text-xs font-semibold text-white transition-colors hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : getString("chat_send_button")}
        </button>
      </div>
      {errorText && <p className="mt-1 px-1 text-[11px] text-red-400">{errorText}</p>}
    </div>
  );
}

function sendErrorText(errorKind: string | null, errorMessage: string | null): string {
  switch (errorKind) {
    case "not_signed_in":
      return getString("chat_send_error_not_signed_in");
    case "rate_limited":
      return getString("chat_send_error_rate_limited");
    default:
      return errorMessage || getString("chat_send_error_rejected");
  }
}

export default ChatOverlay;
