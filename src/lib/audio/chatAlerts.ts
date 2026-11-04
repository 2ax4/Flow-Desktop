import { createAudioContext, resumeWithin } from "./audioContext";
import { matchesHighlight, messageText } from "../chatOverlayLogic";
import type { LiveChatMessage } from "../../types/video";

export interface ChatAlertsOptions {
  soundSuperChat: boolean;
  soundHighlight: boolean;
  ttsSuperChat: boolean;
  ttsHighlight: boolean;
  /** Keywords that make a plain message a "highlight". */
  highlightKeywords: string[];
  muted: boolean;
}

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) ctx = createAudioContext();
  if (ctx && ctx.state === "suspended") void resumeWithin(ctx);
  return ctx;
}

function tone(frequency: number, startAt: number, durationSeconds: number, peak = 0.15) {
  const context = audioContext();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  const start = context.currentTime + startAt;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSeconds);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + durationSeconds + 0.05);
}

/** Two-tone bell for an incoming Super Chat. */
export function playSuperChatChime() {
  tone(880, 0, 0.35);
  tone(1320, 0.12, 0.45);
}

/** Short ping for a highlighted message. */
export function playHighlightPing() {
  tone(1200, 0, 0.25);
}

export function speak(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 120));
    utterance.volume = 0.9;
    // One at a time: a burst of chats must not queue a minute of speech.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech is best-effort.
  }
}

function superChatText(message: LiveChatMessage): string {
  const amount = message.superChatAmount ? `${message.superChatAmount} ` : "";
  return `${message.author} sent ${amount}- ${messageText(message)}`.replace(/\s+-\s*$/, "");
}

/** Fires sounds and speech for a batch of fresh live messages; never throws. */
export async function fireChatAlerts(messages: LiveChatMessage[], options: ChatAlertsOptions): Promise<void> {
  if (options.muted || messages.length === 0) return;
  for (const message of messages) {
    if (message.messageType === "superChat") {
      if (options.soundSuperChat) playSuperChatChime();
      if (options.ttsSuperChat) speak(superChatText(message));
      continue;
    }
    if (matchesHighlight(message, options.highlightKeywords)) {
      if (options.soundHighlight) playHighlightPing();
      if (options.ttsHighlight) speak(`${message.author} says ${messageText(message)}`);
    }
  }
}
