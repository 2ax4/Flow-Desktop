import { describe, expect, it } from "vitest";
import type { LiveChatMessage } from "../types/video";
import {
  clampOverlayPlacement,
  computeSessionAnalytics,
  DEFAULT_OVERLAY_GEOMETRY,
  isBlockedUser,
  isEmojiSpam,
  isFilteredByWords,
  matchesHighlight,
  mergeDuplicates,
  parseAmount,
  parseOverlayGeometry,
  parseStringList,
} from "./chatOverlayLogic";

const message = (overrides: Partial<LiveChatMessage> = {}): LiveChatMessage => ({
  id: "m1",
  author: "Viewer",
  message: "hello",
  segments: [{ text: "hello" }],
  messageType: "text",
  isOwner: false,
  isModerator: false,
  isVerified: false,
  isMember: false,
  ...overrides,
});

describe("overlay geometry", () => {
  it("parses saved geometry and falls back to defaults", () => {
    expect(parseOverlayGeometry(null)).toEqual(DEFAULT_OVERLAY_GEOMETRY);
    expect(parseOverlayGeometry("{}")).toEqual(DEFAULT_OVERLAY_GEOMETRY);
    expect(parseOverlayGeometry("not json")).toEqual(DEFAULT_OVERLAY_GEOMETRY);
    expect(
      parseOverlayGeometry(JSON.stringify({ leftRatio: 0.2, topRatio: 0.3, widthRatio: 0.4, heightRatio: 0.5 })),
    ).toEqual({ leftRatio: 0.2, topRatio: 0.3, widthRatio: 0.4, heightRatio: 0.5 });
  });

  it("clamps out-of-range ratios and enforces a minimum size", () => {
    const clamped = parseOverlayGeometry(
      JSON.stringify({ leftRatio: -2, topRatio: 5, widthRatio: 0.01, heightRatio: 3 }),
    );
    expect(clamped.leftRatio).toBe(0);
    expect(clamped.topRatio).toBe(1);
    expect(clamped.widthRatio).toBeGreaterThanOrEqual(0.12);
    expect(clamped.heightRatio).toBeLessThanOrEqual(1);
  });

  it("keeps a dragged panel inside its container", () => {
    const placed = clampOverlayPlacement(
      { leftRatio: 0.9, topRatio: 0.9, widthRatio: 0.4, heightRatio: 0.5 },
      1000,
      500,
    );
    expect(placed.leftRatio).toBeLessThanOrEqual(0.6);
    expect(placed.topRatio).toBeLessThanOrEqual(0.5);
  });
});

describe("string lists", () => {
  it("accepts JSON arrays and comma-separated text", () => {
    expect(parseStringList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseStringList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(parseStringList("")).toEqual([]);
    expect(parseStringList("{weird")).toEqual([]);
  });
});

describe("amount parsing", () => {
  it("parses currency amounts, thousands and plain digits", () => {
    expect(parseAmount("$1.50")).toEqual({ currency: "$", value: 1.5 });
    expect(parseAmount("$10K")).toEqual({ currency: "$", value: 10000 });
    expect(parseAmount("₹1,250")).toEqual({ currency: "₹", value: 1250 });
    expect(parseAmount("5")).toEqual({ currency: "", value: 5 });
    expect(parseAmount("chatter")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe("filters", () => {
  it("highlights by case-insensitive keyword", () => {
    expect(matchesHighlight(message(), ["Hello"])).toBe(true);
    expect(matchesHighlight(message(), ["world"])).toBe(false);
    expect(matchesHighlight(message(), [])).toBe(false);
  });

  it("hides messages with filtered words", () => {
    expect(isFilteredByWords(message(), ["hello"])).toBe(true);
    expect(isFilteredByWords(message(), ["bye"])).toBe(false);
  });

  it("blocks users by name, tolerating @ prefixes", () => {
    expect(isBlockedUser(message(), ["viewer"])).toBe(true);
    expect(isBlockedUser(message(), ["@Viewer"])).toBe(true);
    expect(isBlockedUser(message(), ["someone else"])).toBe(false);
  });

  it("flags emoji spam", () => {
    const emojis = Array.from({ length: 9 }, () => ({ text: "🎉", emojiImageUrl: "https://x/e.png" }));
    expect(isEmojiSpam(message({ segments: emojis }))).toBe(true);
    expect(isEmojiSpam(message())).toBe(false);
    expect(isEmojiSpam(message({ segments: [{ text: "🎉🎉🎉🎉🎉🎉🎉🎉🎉" }] }))).toBe(true);
    expect(isEmojiSpam(message({ segments: [{ text: "🎉 ok" }] }))).toBe(false);
  });
});

describe("duplicate merge", () => {
  it("collapses consecutive same author+text messages with an xN count", () => {
    const merged = mergeDuplicates([
      message({ id: "a" }),
      message({ id: "b" }),
      message({ id: "c", author: "Other" }),
      message({ id: "d" }),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.count).toBe(2);
    expect(merged[0]?.message.id).toBe("a");
    expect(merged[1]?.count).toBe(1);
  });

  it("keeps different text apart", () => {
    const merged = mergeDuplicates([message({ id: "a" }), message({ id: "b", message: "hi", segments: [{ text: "hi" }] })]);
    expect(merged).toHaveLength(2);
  });
});

describe("session analytics", () => {
  it("sums super chats, counts them and ranks supporters", () => {
    const now = Date.now();
    const messages = [
      message({ id: "1", messageType: "superChat", superChatAmount: "$2.00" }),
      message({ id: "2", messageType: "superChat", superChatAmount: "$10K" }),
      message({ id: "3", messageType: "superChat", superChatAmount: "$1.50" }),
      message({ id: "4" }),
    ];
    const analytics = computeSessionAnalytics(messages, 60000);
    expect(analytics.superChatCount).toBe(3);
    expect(analytics.superChatTotal).toBeCloseTo(10003.5, 2);
    expect(analytics.superChatCurrency).toBe("$");
    expect(analytics.topSupporters[0]?.author).toBe("Viewer");
    expect(analytics.messagesPerMinute).toBe(4);
    void now;
  });

  it("counts messages per minute for short sessions", () => {
    const analytics = computeSessionAnalytics([message(), message(), message(), message()], 30000);
    expect(analytics.messagesPerMinute).toBe(8);
  });
});
