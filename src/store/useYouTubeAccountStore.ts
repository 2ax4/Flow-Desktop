import { create } from "zustand";
import {
  ANONYMOUS_ACCOUNT,
  getYouTubeLoginStatus,
  onYouTubeAccount,
  youtubeLogout,
  type YouTubeAccountState,
} from "../lib/api/youtubeAccount";

interface YouTubeAccountStoreState {
  account: YouTubeAccountState;
  loaded: boolean;
  /** Fetches the current account once and keeps the push-event listener attached. */
  initialize: () => Promise<void>;
  signOut: () => Promise<void>;
}

let listening = false;

export const useYouTubeAccountStore = create<YouTubeAccountStoreState>((set) => ({
  account: ANONYMOUS_ACCOUNT,
  loaded: false,

  initialize: async () => {
    if (!listening) {
      listening = true;
      void onYouTubeAccount((account) => set({ account, loaded: true })).catch(() => {
        listening = false;
      });
    }
    if (useYouTubeAccountStore.getState().loaded) return;
    try {
      const account = await getYouTubeLoginStatus();
      set({ account, loaded: true });
    } catch (error) {
      console.warn("YouTube account status unavailable", error);
      set({ loaded: true });
    }
  },

  signOut: async () => {
    try {
      await youtubeLogout();
      set({ account: ANONYMOUS_ACCOUNT });
    } catch (error) {
      console.warn("YouTube sign-out failed", error);
    }
  },
}));

export function useYouTubeAccount(): YouTubeAccountState {
  const account = useYouTubeAccountStore((s) => s.account);
  return account;
}
