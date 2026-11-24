import { useLayoutEffect } from "react";
import { isIOS } from "./platform";

type TabBridge = { postMessage: (value: unknown) => Promise<boolean> };

function tabBridge() {
  return (window as Window & { webkit?: { messageHandlers?: { norrVehicleTabs?: TabBridge } } })
    .webkit?.messageHandlers?.norrVehicleTabs;
}

export function useIOSTabBar(pages: { id: string; label: string }[], select: (page: string) => void) {
  useLayoutEffect(() => {
    if (!isIOS) return;
    const root = document.documentElement;
    const nav = document.querySelector<HTMLElement>(".native-header .navigation");
    if (!nav) return;
    let revision = 0;
    let previous: string | undefined;
    const sync = () => {
      const bridge = tabBridge();
      if (!bridge) return;
      const active = document.activeElement;
      const show = !root.dataset.windowDivision && matchMedia("(max-width: 760px)").matches &&
        !document.querySelector("dialog[open]") && !active?.matches("input, textarea, [contenteditable=true]") &&
        nav.getClientRects().length > 0;
      const { x, y, width, height } = nav.getBoundingClientRect();
      const selected = Array.from(nav.children).findIndex(item => item.getAttribute("aria-current") === "page");
      const body = show ? { x, y, width, height, selected,
        labels: pages.map(item => item.label), dark: root.dataset.theme === "dark" } : null;
      const signature = JSON.stringify(body);
      if (signature === previous) return;
      previous = signature;
      const revisionAtSend = ++revision;
      void bridge.postMessage(body).then(visible => {
        if (revision === revisionAtSend) nav.classList.toggle("ios-system-tabs", visible);
      }).catch(() => { if (revision === revisionAtSend) nav.classList.remove("ios-system-tabs"); });
    };
    const onSelect = (event: Event) => {
      const target = pages[(event as CustomEvent<number>).detail];
      if (target && nav.classList.contains("ios-system-tabs")) select(target.id);
    };
    const mutations = new MutationObserver(sync);
    mutations.observe(root, { attributes: true, attributeFilter: ["data-window-division", "data-theme"] });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "hidden", "aria-current"] });
    const size = new ResizeObserver(sync);
    size.observe(nav);
    window.addEventListener("resize", sync);
    window.addEventListener("norr-tabs-ready", sync);
    window.addEventListener("norr-tab-select", onSelect);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    sync();
    return () => {
      revision++;
      mutations.disconnect();
      size.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("norr-tabs-ready", sync);
      window.removeEventListener("norr-tab-select", onSelect);
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
      nav.classList.remove("ios-system-tabs");
      void tabBridge()?.postMessage(null).catch(() => {});
    };
  }, [pages, select]);
}
