import { describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = ResizeObserverStub as never;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("no-tauri-in-tests"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePlayerStore } from "../../store/usePlayerStore";
import { ChatOverlay } from "./ChatOverlay";

function mountProbe(): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { root, container };
}

describe("ChatOverlay render loop probe", () => {
  it("mounts the overlay without an update-depth loop", async () => {
    usePlayerStore.setState({
      currentVideo: { id: "dQw4w9WgXcQ", title: "probe live" } as never,
      isLiveChatAvailable: true,
    });

    const { root, container } = mountProbe();
    const depthErrors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      const text = parts.map(String).join(" ");
      if (text.includes("Maximum update depth") || text.includes("getSnapshot")) depthErrors.push(text);
    };

    let mountError: unknown = null;
    try {
      await act(async () => {
        root.render(
          createElement(ChatOverlay, {
            isReplay: false,
            onClose: () => {},
          }),
        );
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    } catch (error) {
      mountError = error;
    } finally {
      console.error = originalError;
    }

    const html = container.innerHTML;
    await act(async () => {
      root.unmount();
    });
    container.remove();

    if (mountError) throw mountError;
    expect(html).toContain("complementary");
    expect(depthErrors).toEqual([]);
  });
});