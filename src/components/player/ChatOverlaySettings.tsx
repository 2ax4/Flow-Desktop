import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getString } from "../../lib/i18n/index";
import { SETTINGS, type SettingKey } from "../../lib/settings/schema";
import { setSettingValue, useAppSettingsStore } from "../../store/useAppSettingsStore";
import { parseStringList } from "../../lib/chatOverlayLogic";
import { Slider } from "../ui/Slider";
import { TextInput } from "../ui/TextInput";
import { ToggleSwitch } from "../ui/ToggleSwitch";

const LIFETIME_CHOICES = [0, 15, 30, 60, 120];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function useSettingBool(key: SettingKey, fallback: boolean): [boolean, (value: boolean) => void] {
  const stored = useAppSettingsStore((s) => s.values[key]);
  const value = stored === undefined ? fallback : stored === "true";
  return [value, (next) => void setSettingValue(key, String(next))];
}

function useSettingNumber(key: SettingKey, fallback: number): [number, (value: number) => void] {
  const stored = useAppSettingsStore((s) => s.values[key]);
  const value = stored === undefined ? fallback : Number(stored);
  return [Number.isFinite(value) ? value : fallback, (next) => void setSettingValue(key, String(next))];
}

function PopupShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute right-2 top-9 z-40 flex max-h-[75%] w-[min(300px,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-white/15 bg-chrome-neutral-950/95 shadow-2xl backdrop-blur-sm">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-bold uppercase tracking-wide text-white/85">{title}</span>
        <button
          type="button"
          aria-label={getString("chat_overlay_close")}
          onClick={onClose}
          className="grid h-5 w-5 place-items-center rounded text-white/60 hover:bg-white/10 hover:text-white"
        >
          <X size={12} />
        </button>
      </div>
      <div className="hide-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-white/80">{label}</span>
      {children}
    </div>
  );
}

function ListField({ label, placeholder, settingKey }: { label: string; placeholder: string; settingKey: SettingKey }) {
  const stored = useAppSettingsStore((s) => s.values[settingKey]) ?? "";
  const [draft, setDraft] = useState(() => parseStringList(stored).join(", "));
  const [focused, setFocused] = useState(false);

  // Refresh from the store when the field is not being edited.
  useEffect(() => {
    if (!focused) setDraft(parseStringList(stored).join(", "));
  }, [stored, focused]);

  const commit = () => {
    setFocused(false);
    void setSettingValue(settingKey, JSON.stringify(parseStringList(draft)));
  };

  return (
    <label className="block space-y-1">
      <span className="text-xs text-white/80">{label}</span>
      <TextInput
        value={draft}
        placeholder={placeholder}
        onChange={setDraft}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        className="w-full !text-xs"
      />
    </label>
  );
}

export function ChatOverlaySettings({ onClose }: { onClose: () => void }) {
  const [fontSize, setFontSize] = useSettingNumber(SETTINGS.CHAT_OVERLAY_FONT_SIZE, 14);
  const [opacity, setOpacity] = useSettingNumber(SETTINGS.CHAT_OVERLAY_OPACITY, 80);
  const [maxMessages, setMaxMessages] = useSettingNumber(SETTINGS.CHAT_OVERLAY_MAX_MESSAGES, 18);
  const [lifetime, setLifetime] = useSettingNumber(SETTINGS.CHAT_OVERLAY_MESSAGE_LIFETIME, 0);

  const [bubbles, setBubbles] = useSettingBool(SETTINGS.CHAT_OVERLAY_BUBBLES, true);
  const [avatars, setAvatars] = useSettingBool(SETTINGS.CHAT_OVERLAY_AVATARS, true);
  const [badges, setBadges] = useSettingBool(SETTINGS.CHAT_OVERLAY_BADGES, true);
  const [fadeIdle, setFadeIdle] = useSettingBool(SETTINGS.CHAT_OVERLAY_FADE_IDLE, true);
  const [emojiSpam, setEmojiSpam] = useSettingBool(SETTINGS.CHAT_OVERLAY_EMOJI_SPAM_FILTER, false);
  const [mergeDuplicates, setMergeDuplicates] = useSettingBool(SETTINGS.CHAT_OVERLAY_MERGE_DUPLICATES, true);
  const [soundSuperChat, setSoundSuperChat] = useSettingBool(SETTINGS.CHAT_ALERTS_SOUND_SUPERCHAT, true);
  const [soundHighlight, setSoundHighlight] = useSettingBool(SETTINGS.CHAT_ALERTS_SOUND_HIGHLIGHT, false);
  const [ttsSuperChat, setTtsSuperChat] = useSettingBool(SETTINGS.CHAT_ALERTS_TTS_SUPERCHAT, false);
  const [ttsHighlight, setTtsHighlight] = useSettingBool(SETTINGS.CHAT_ALERTS_TTS_HIGHLIGHT, false);

  return (
    <PopupShell title={getString("chat_overlay_settings")} onClose={onClose}>
      <div className="space-y-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-white/80">
            <span>{getString("chat_overlay_font_size")}</span>
            <span className="tabular-nums text-white/60">{fontSize}px</span>
          </div>
          <Slider value={fontSize} min={10} max={36} onChange={setFontSize} aria-label={getString("chat_overlay_font_size")} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-white/80">
            <span>{getString("chat_overlay_opacity")}</span>
            <span className="tabular-nums text-white/60">{opacity}%</span>
          </div>
          <Slider value={opacity} min={10} max={100} onChange={setOpacity} aria-label={getString("chat_overlay_opacity")} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-white/80">
            <span>{getString("chat_overlay_max_messages")}</span>
            <span className="tabular-nums text-white/60">{maxMessages}</span>
          </div>
          <Slider value={maxMessages} min={5} max={60} onChange={setMaxMessages} aria-label={getString("chat_overlay_max_messages")} />
        </div>
        <Row label={getString("chat_overlay_lifetime")}>
          <div className="flex items-center gap-1">
            {LIFETIME_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={lifetime === choice}
                onClick={() => setLifetime(choice)}
                className={cx(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors",
                  lifetime === choice ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10",
                )}
              >
                {choice === 0 ? getString("chat_overlay_lifetime_off") : getString("chat_overlay_lifetime_seconds", String(choice))}
              </button>
            ))}
          </div>
        </Row>
      </div>

      <div className="space-y-2 border-t border-white/10 pt-2">
        <Row label={getString("chat_overlay_bubbles")}>
          <ToggleSwitch checked={bubbles} onChange={setBubbles} />
        </Row>
        <Row label={getString("chat_overlay_avatars")}>
          <ToggleSwitch checked={avatars} onChange={setAvatars} />
        </Row>
        <Row label={getString("chat_overlay_badges")}>
          <ToggleSwitch checked={badges} onChange={setBadges} />
        </Row>
        <Row label={getString("chat_overlay_fade")}>
          <ToggleSwitch checked={fadeIdle} onChange={setFadeIdle} />
        </Row>
        <Row label={getString("chat_overlay_emoji_spam")}>
          <ToggleSwitch checked={emojiSpam} onChange={setEmojiSpam} />
        </Row>
        <Row label={getString("chat_overlay_merge")}>
          <ToggleSwitch checked={mergeDuplicates} onChange={setMergeDuplicates} />
        </Row>
      </div>

      <div className="space-y-2 border-t border-white/10 pt-2">
        <p className="text-xs font-bold uppercase tracking-wide text-white/70">{getString("chat_alerts_title")}</p>
        <Row label={getString("chat_alerts_sound_superchat")}>
          <ToggleSwitch checked={soundSuperChat} onChange={setSoundSuperChat} />
        </Row>
        <Row label={getString("chat_alerts_sound_highlight")}>
          <ToggleSwitch checked={soundHighlight} onChange={setSoundHighlight} />
        </Row>
        <Row label={getString("chat_alerts_tts_superchat")}>
          <ToggleSwitch checked={ttsSuperChat} onChange={setTtsSuperChat} />
        </Row>
        <Row label={getString("chat_alerts_tts_highlight")}>
          <ToggleSwitch checked={ttsHighlight} onChange={setTtsHighlight} />
        </Row>
      </div>

      <div className="space-y-2 border-t border-white/10 pt-2">
        <p className="text-xs font-bold uppercase tracking-wide text-white/70">{getString("chat_overlay_filters_title")}</p>
        <ListField label={getString("chat_overlay_highlight")} placeholder={getString("chat_overlay_highlight_placeholder")} settingKey={SETTINGS.CHAT_OVERLAY_HIGHLIGHT_KEYWORDS} />
        <ListField label={getString("chat_overlay_filtered_words")} placeholder={getString("chat_overlay_filtered_words_placeholder")} settingKey={SETTINGS.CHAT_OVERLAY_FILTERED_WORDS} />
        <ListField label={getString("chat_overlay_blocked_users")} placeholder={getString("chat_overlay_blocked_users_placeholder")} settingKey={SETTINGS.CHAT_OVERLAY_BLOCKED_USERS} />
      </div>
    </PopupShell>
  );
}

export default ChatOverlaySettings;
