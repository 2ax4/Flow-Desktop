import { useMemo } from "react";
import { Download, FileText, X } from "lucide-react";
import { getString } from "../../lib/i18n/index";
import { copyText } from "../../lib/clipboard";
import {
  analyticsCsv,
  analyticsSummary,
  analyticsTxt,
  computeSessionAnalytics,
  formatAmountValue,
} from "../../lib/chatOverlayLogic";
import type { LiveChatMessage } from "../../types/video";

interface ChatOverlayAnalyticsProps {
  messages: LiveChatMessage[];
  sessionStartMs: number;
  onClose: () => void;
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ChatOverlayAnalytics({ messages, sessionStartMs, onClose }: ChatOverlayAnalyticsProps) {
  const analytics = useMemo(
    () => computeSessionAnalytics(messages, Math.max(Date.now() - sessionStartMs, 0)),
    [messages, sessionStartMs],
  );
  const currency = analytics.superChatCurrency ?? "";

  const buttonClass =
    "flex items-center justify-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-white/90 transition-colors hover:bg-white/20";

  return (
    <div className="absolute right-2 top-9 z-40 flex max-h-[75%] w-[min(300px,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-white/15 bg-chrome-neutral-950/95 shadow-2xl backdrop-blur-sm">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-bold uppercase tracking-wide text-white/85">{getString("chat_analytics_title")}</span>
        <button
          type="button"
          aria-label={getString("chat_overlay_close")}
          onClick={onClose}
          className="grid h-5 w-5 place-items-center rounded text-white/60 hover:bg-white/10 hover:text-white"
        >
          <X size={12} />
        </button>
      </div>

      <div className="hide-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="text-xs text-white/60">{getString("chat_analytics_empty")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-white/5 p-2">
                <p className="text-[10px] uppercase tracking-wide text-white/55">{getString("chat_analytics_superchat_total")}</p>
                <p className="text-sm font-bold text-amber-300">
                  {currency}
                  {formatAmountValue(analytics.superChatTotal)}
                </p>
              </div>
              <div className="rounded-lg bg-white/5 p-2">
                <p className="text-[10px] uppercase tracking-wide text-white/55">{getString("chat_analytics_superchat_count")}</p>
                <p className="text-sm font-bold text-white/90">{analytics.superChatCount}</p>
              </div>
              <div className="rounded-lg bg-white/5 p-2">
                <p className="text-[10px] uppercase tracking-wide text-white/55">{getString("chat_analytics_messages_per_minute")}</p>
                <p className="text-sm font-bold text-white/90">{analytics.messagesPerMinute}</p>
              </div>
            </div>

            {analytics.topSupporters.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wide text-white/55">
                  {getString("chat_analytics_top_supporters")}
                </p>
                {analytics.topSupporters.map((supporter, index) => (
                  <div key={supporter.author} className="flex items-center justify-between gap-2 text-xs text-white/85">
                    <span className="min-w-0 truncate">
                      {index + 1}. {supporter.author}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-amber-300">
                      {supporter.currency}
                      {formatAmountValue(supporter.total)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-3 gap-1.5 border-t border-white/10 pt-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => download("flow-chat-log.csv", analyticsCsv(messages), "text/csv")}
              >
                <Download size={12} />
                {getString("chat_analytics_export_csv")}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => download("flow-chat-log.txt", analyticsTxt(messages), "text/plain")}
              >
                <FileText size={12} />
                {getString("chat_analytics_export_txt")}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => void copyText(analyticsSummary(messages, Math.max(Date.now() - sessionStartMs, 0)))}
              >
                {getString("chat_analytics_copy_summary")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default ChatOverlayAnalytics;
