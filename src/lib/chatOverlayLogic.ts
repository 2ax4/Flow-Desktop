import type { LiveChatMessage, LiveChatSegment } from "../types/video";

export interface OverlayGeometry {
  leftRatio: number;
  topRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export const DEFAULT_OVERLAY_GEOMETRY: OverlayGeometry = {
  leftRatio: 0.55,
  topRatio: 0.08,
  widthRatio: 0.42,
  heightRatio: 0.6,
};

const clampRatio = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

/** Minimum panel fraction of its container, so a tiny saved size stays usable. */
const MIN_WIDTH_RATIO = 0.12;
const MIN_HEIGHT_RATIO = 0.15;

export function clampOverlayGeometry(geometry: OverlayGeometry): OverlayGeometry {
  return {
    leftRatio: clampRatio(geometry.leftRatio, DEFAULT_OVERLAY_GEOMETRY.leftRatio),
    topRatio: clampRatio(geometry.topRatio, DEFAULT_OVERLAY_GEOMETRY.topRatio),
    widthRatio: Math.max(MIN_WIDTH_RATIO, clampRatio(geometry.widthRatio, DEFAULT_OVERLAY_GEOMETRY.widthRatio)),
    heightRatio: Math.max(MIN_HEIGHT_RATIO, clampRatio(geometry.heightRatio, DEFAULT_OVERLAY_GEOMETRY.heightRatio)),
  };
}

export function parseOverlayGeometry(raw: string | null | undefined): OverlayGeometry {
  if (!raw || raw === "{}") return { ...DEFAULT_OVERLAY_GEOMETRY };
  try {
    const parsed = JSON.parse(raw) as Partial<OverlayGeometry>;
    return clampOverlayGeometry({
      leftRatio: parsed.leftRatio ?? DEFAULT_OVERLAY_GEOMETRY.leftRatio,
      topRatio: parsed.topRatio ?? DEFAULT_OVERLAY_GEOMETRY.topRatio,
      widthRatio: parsed.widthRatio ?? DEFAULT_OVERLAY_GEOMETRY.widthRatio,
      heightRatio: parsed.heightRatio ?? DEFAULT_OVERLAY_GEOMETRY.heightRatio,
    });
  } catch {
    return { ...DEFAULT_OVERLAY_GEOMETRY };
  }
}

/** Left/top ratios also clamp so a wide panel never hangs past its container's right/bottom edge. */
export function clampOverlayPlacement(
  geometry: OverlayGeometry,
  containerWidth: number,
  containerHeight: number,
): OverlayGeometry {
  const clamped = clampOverlayGeometry(geometry);
  const maxWidth = containerWidth * (1 - MIN_WIDTH_RATIO);
  const maxHeight = containerHeight * (1 - MIN_HEIGHT_RATIO);
  const maxLeft = Math.max(0, 1 - clamped.widthRatio);
  const maxTop = Math.max(0, 1 - clamped.heightRatio);
  if (containerWidth > 0) {
    clamped.widthRatio = Math.min(clamped.widthRatio, maxWidth / containerWidth);
  }
  if (containerHeight > 0) {
    clamped.heightRatio = Math.min(clamped.heightRatio, maxHeight / containerHeight);
  }
  return {
    ...clamped,
    leftRatio: Math.min(clamped.leftRatio, maxLeft),
    topRatio: Math.min(clamped.topRatio, maxTop),
  };
}

/** Accepts a persisted JSON array or a comma-separated string. */
export function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    }
  } catch {
    // Fall through to the comma-separated form.
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** `"$1.50"` -> 1.5, `"$10K"` -> 10000; keeps the currency symbol for grouping. */
export function parseAmount(amount: string | null | undefined): { currency: string; value: number } | null {
  if (!amount) return null;
  const text = amount.trim();
  if (!text) return null;
  const currencyMatch = text.match(/^[^\d.,\sKk]*/);
  const currency = (currencyMatch?.[0] ?? "").trim();
  const kSuffix = /([kK])\s*$/.test(text);
  const digits = text.replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (!digits) return null;
  const value = parseFloat(digits) * (kSuffix ? 1000 : 1);
  return Number.isFinite(value) ? { currency, value } : null;
}

export function formatAmountValue(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

export function argbToCss(argb: number | null | undefined): string | undefined {
  if (argb == null) return undefined;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${r}, ${g}, ${b}, ${a || 1})`;
}

export function argbToHex(argb: number | null | undefined): string | undefined {
  if (argb == null) return undefined;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// Rec. 709 luma decides black vs white foreground over a colored background.
export function prefersDarkText(argb: number | null | undefined): boolean {
  if (argb == null) return false;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
}

/** Stable hash so an author always gets the same accent hue. */
export function authorHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export function authorColor(name: string): string {
  return `hsl(${authorHue(name)}, 65%, 72%)`;
}

export function messageText(message: LiveChatMessage): string {
  if (!message.segments?.length) return message.message;
  return message.segments.map((segment) => segment.text).join("");
}

export function matchesHighlight(message: LiveChatMessage, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const text = messageText(message).toLowerCase();
  return keywords.some((keyword) => {
    const needle = keyword.toLowerCase().trim();
    return needle.length > 0 && text.includes(needle);
  });
}

export function isFilteredByWords(message: LiveChatMessage, words: string[]): boolean {
  if (words.length === 0) return false;
  const text = messageText(message).toLowerCase();
  return words.some((word) => {
    const needle = word.toLowerCase().trim();
    return needle.length > 0 && text.includes(needle);
  });
}

/** Blocked users match by author name or @handle, case-insensitive. */
export function isBlockedUser(message: LiveChatMessage, blockedUsers: string[]): boolean {
  if (blockedUsers.length === 0) return false;
  const author = message.author.toLowerCase();
  return blockedUsers.some((entry) => {
    const needle = entry.toLowerCase().trim().replace(/^@+/, "");
    return needle.length > 0 && (author === needle || author.startsWith(`${needle} `) || author.includes(needle));
  });
}

const EMOJI_CHAR_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/u;

function isEmojiText(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  if (!stripped) return false;
  let emojiChars = 0;
  for (const char of stripped) {
    if (EMOJI_CHAR_RE.test(char)) emojiChars += 1;
  }
  return emojiChars / Array.from(stripped).length >= 0.6;
}

/** Emoji-ish segment: a custom emoji image, or text that is mostly emoji characters. */
function isEmojiSegment(segment: LiveChatSegment): boolean {
  if (segment.emojiImageUrl) return true;
  return isEmojiText(segment.text ?? "");
}

/** More than 8 emoji segments, or more than 60% emoji characters overall. */
export function isEmojiSpam(message: LiveChatMessage): boolean {
  const segments = message.segments ?? [];
  if (segments.length === 0) return false;
  const emojiSegments = segments.filter(isEmojiSegment);
  if (emojiSegments.length > 8) return true;
  const allChars = Array.from(messageText(message).replace(/\s/g, ""));
  if (allChars.length === 0) return false;
  let emojiChars = 0;
  for (const char of allChars) {
    if (EMOJI_CHAR_RE.test(char)) emojiChars += 1;
  }
  return emojiChars / allChars.length > 0.6;
}

export function normalizedDuplicateKey(message: LiveChatMessage): string {
  return `${message.author}\u0000${messageText(message).replace(/\s+/g, " ").trim().toLowerCase()}`;
}

export interface MergedChatRow {
  message: LiveChatMessage;
  count: number;
}

/** Collapses consecutive same-author, same-text messages into one row with an xN badge. */
export function mergeDuplicates(messages: LiveChatMessage[]): MergedChatRow[] {
  const rows: MergedChatRow[] = [];
  for (const message of messages) {
    const last = rows[rows.length - 1];
    if (last && normalizedDuplicateKey(last.message) === normalizedDuplicateKey(message)) {
      last.count += 1;
      continue;
    }
    rows.push({ message, count: 1 });
  }
  return rows;
}

export interface OverlayFilterOptions {
  keywords: string[];
  filteredWords: string[];
  blockedUsers: string[];
  emojiSpamFilter: boolean;
}

/** The overlay's view of a message: visible, and highlighted when it matches a keyword. */
export interface OverlayMessage {
  message: LiveChatMessage;
  highlighted: boolean;
}

export function toOverlayMessages(messages: LiveChatMessage[], options: OverlayFilterOptions): OverlayMessage[] {
  return messages
    .filter((message) => !isFilteredByWords(message, options.filteredWords))
    .filter((message) => !isBlockedUser(message, options.blockedUsers))
    .filter((message) => !(options.emojiSpamFilter && isEmojiSpam(message)))
    .map((message) => ({ message, highlighted: matchesHighlight(message, options.keywords) }));
}

export interface Supporter {
  author: string;
  total: number;
  currency: string;
}

export interface SessionAnalytics {
  superChatTotal: number;
  superChatCurrency: string | null;
  superChatCount: number;
  topSupporters: Supporter[];
  messagesPerMinute: number;
}

export function computeSessionAnalytics(
  messages: LiveChatMessage[],
  sessionDurationMs: number,
): SessionAnalytics {
  let superChatTotal = 0;
  let superChatCount = 0;
  const currencyCounts = new Map<string, number>();
  const supporterTotals = new Map<string, { total: number; currency: string }>();

  for (const message of messages) {
    if (message.messageType !== "superChat") continue;
    const parsed = parseAmount(message.superChatAmount);
    superChatCount += 1;
    if (!parsed) continue;
    superChatTotal += parsed.value;
    currencyCounts.set(parsed.currency, (currencyCounts.get(parsed.currency) ?? 0) + 1);
    const supporter = supporterTotals.get(message.author);
    if (supporter) {
      supporter.total += parsed.value;
    } else {
      supporterTotals.set(message.author, { total: parsed.value, currency: parsed.currency });
    }
  }

  let superChatCurrency: string | null = null;
  let currencyBest = 0;
  for (const [currency, count] of currencyCounts) {
    if (count > currencyBest) {
      superChatCurrency = currency;
      currencyBest = count;
    }
  }

  const minutes = Math.max(sessionDurationMs / 60000, 1 / 60);
  return {
    superChatTotal,
    superChatCurrency,
    superChatCount,
    topSupporters: Array.from(supporterTotals, ([author, { total, currency }]) => ({ author, total, currency }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5),
    messagesPerMinute: Math.round(messages.length / minutes),
  };
}

export function analyticsCsv(messages: LiveChatMessage[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = messages.map((message) => {
    const kind = message.messageType === "superChat" ? message.superChatAmount ?? "" : message.messageType;
    return [message.timestamp ?? "", message.author, kind, messageText(message)].map(escape).join(",");
  });
  return ["timestamp,author,type,message", ...rows].join("\n");
}

export function analyticsTxt(messages: LiveChatMessage[]): string {
  return messages
    .map((message) => {
      const kind = message.messageType === "superChat" ? ` [${message.superChatAmount ?? "Super Chat"}]` : "";
      return `${message.timestamp ? `${message.timestamp} ` : ""}${message.author}${kind}: ${messageText(message)}`;
    })
    .join("\n");
}

export function analyticsSummary(messages: LiveChatMessage[], sessionDurationMs: number): string {
  const analytics = computeSessionAnalytics(messages, sessionDurationMs);
  const currency = analytics.superChatCurrency ?? "";
  const lines = [
    `Super Chat total: ${currency}${formatAmountValue(analytics.superChatTotal)} (${analytics.superChatCount})`,
    `Messages/min: ${analytics.messagesPerMinute}`,
    "Top supporters:",
    ...analytics.topSupporters.map(
      (supporter, index) => `${index + 1}. ${supporter.author} - ${supporter.currency}${formatAmountValue(supporter.total)}`,
    ),
  ];
  return lines.join("\n");
}
