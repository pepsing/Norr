import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import polestar from "../assets/brand/polestar.svg";
import "./sky-pull-refresh.css";

type Phase = "idle" | "pulling" | "preview" | "held" | "refreshing" | "success" | "partial" | "error" | "closing";
export type RefreshOutcome = "success" | "partial" | "error" | "cancelled";
type Gesture = { x: number; y: number; distance: number; claimed: boolean };
const threshold = 128;
const maxPull = 192;

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const abort = () => { window.clearTimeout(timer); resolve(false); };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function SkyPullRefresh({ children, enabled, busy, onRefresh, resetKey, preview = false, successLabel = "本次车辆读取已完成" }: {
  children: ReactNode;
  enabled: boolean;
  busy: boolean;
  onRefresh: () => Promise<void | RefreshOutcome>;
  resetKey: string;
  preview?: boolean;
  successLabel?: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const operation = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const suppressClick = useRef(false);
  const [distance, setDistance] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const latest = useRef({ enabled, busy, onRefresh });
  latest.current = { enabled, busy, onRefresh };

  useEffect(() => {
    operation.current?.abort();
    operation.current = null;
    locked.current = false;
    gesture.current = null;
    setDistance(0);
    setPhase("idle");
    if (!enabled) return;
    // Prevent the browser's own refresh from competing with the reveal.
    const previous = document.documentElement.style.overscrollBehaviorY;
    document.documentElement.style.overscrollBehaviorY = "none";
    return () => {
      document.documentElement.style.overscrollBehaviorY = previous;
      operation.current?.abort();
    };
  }, [enabled, resetKey]);

  function startOperation() {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    locked.current = true;
    return controller;
  }

  async function close(controller: AbortController) {
    setPhase("closing");
    setDistance(0);
    if (!await wait(440, controller.signal)) return;
    setPhase("idle");
    locked.current = false;
  }

  async function refresh(controller: AbortController) {
    if (controller.signal.aborted) return;
    if (!latest.current.enabled || latest.current.busy) {
      await close(controller);
      return;
    }
    setDistance(150);
    setPhase("refreshing");
    const minimumDisplay = wait(1000, controller.signal);
    let outcome: RefreshOutcome = "success";
    try {
      outcome = await latest.current.onRefresh() ?? "success";
    } catch {
      outcome = "error";
    }
    if (!await minimumDisplay || controller.signal.aborted) return;
    if (outcome === "cancelled") { await close(controller); return; }
    setPhase(outcome);
    if (await wait(outcome === "success" ? 650 : 1700, controller.signal)) await close(controller);
  }

  async function play() {
    if (locked.current || busy || !enabled) return;
    window.scrollTo({ top: 0, behavior: "instant" });
    const controller = startOperation();
    setPhase("preview");
    setDistance(70);
    if (!await wait(450, controller.signal)) return;
    setDistance(172);
    if (!await wait(750, controller.signal)) return;
    await refresh(controller);
  }

  function toggleHeld() {
    if (phase === "held") {
      void close(startOperation());
    } else if (!locked.current && !busy && enabled) {
      window.scrollTo({ top: 0, behavior: "instant" });
      startOperation();
      setDistance(172);
      setPhase("held");
    }
  }

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    function start(x: number, y: number, target: EventTarget | null) {
      if (!latest.current.enabled || latest.current.busy || locked.current || window.scrollY > 0) return;
      if (!(target instanceof Element) || target.closest("button, a, input, select, textarea, summary, [role='dialog']")) return;
      for (let node: Element | null = target; node && node !== element; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
      }
      suppressClick.current = false;
      gesture.current = { x, y, distance: 0, claimed: false };
    }
    function move(x: number, y: number, event: Event) {
      const current = gesture.current;
      if (!current) return;
      const dy = y - current.y;
      if (!current.claimed) {
        if ((Math.abs(x - current.x) > 10 && Math.abs(x - current.x) > dy) || dy < -6) {
          gesture.current = null;
          return;
        }
        if (dy < 8) {
          if (dy > 0 && event.cancelable) event.preventDefault();
          return;
        }
        if (!event.cancelable) { gesture.current = null; return; }
        current.claimed = true;
        suppressClick.current = true;
        window.getSelection()?.removeAllRanges();
        setPhase("pulling");
      }
      if (event.cancelable) event.preventDefault();
      current.distance = maxPull * (1 - Math.exp(-Math.max(0, dy) / 230));
      setDistance(current.distance);
    }
    function end(cancelled = false) {
      const current = gesture.current;
      gesture.current = null;
      if (!current?.claimed) return;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      const controller = startOperation();
      if (!cancelled && current.distance >= threshold) void refresh(controller);
      else void close(controller);
    }
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { end(true); return; }
      start(event.touches[0].clientX, event.touches[0].clientY, event.target);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) { end(true); return; }
      move(event.touches[0].clientX, event.touches[0].clientY, event);
    };
    const touchEnd = () => end();
    const cancel = () => end(true);
    const mouseStart = (event: MouseEvent) => {
      if (event.button !== 0) return;
      start(event.clientX, event.clientY, event.target);
      if (gesture.current) event.preventDefault();
    };
    const mouseMove = (event: MouseEvent) => move(event.clientX, event.clientY, event);
    const mouseEnd = () => end();
    const click = (event: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: false });
    element.addEventListener("touchend", touchEnd);
    element.addEventListener("touchcancel", cancel);
    element.addEventListener("mousedown", mouseStart);
    element.addEventListener("click", click, true);
    window.addEventListener("mousemove", mouseMove);
    window.addEventListener("mouseup", mouseEnd);
    window.addEventListener("blur", cancel);
    return () => {
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
      element.removeEventListener("touchend", touchEnd);
      element.removeEventListener("touchcancel", cancel);
      element.removeEventListener("mousedown", mouseStart);
      element.removeEventListener("click", click, true);
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseEnd);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  const progress = Math.min(distance / threshold, 1);
  const label = phase === "refreshing" ? "正在刷新车辆"
    : phase === "success" ? successLabel
    : phase === "partial" ? "部分车辆数据未更新，请查看读取状态"
    : phase === "error" ? "刷新失败，请重试"
    : phase === "held" ? "松手刷新 · 定格预览"
    : distance >= threshold ? "松手刷新" : "下拉刷新";
  const active = enabled && phase !== "idle";
  const style = {
    "--sky-pull": `${enabled ? distance : 0}px`,
    "--sky-progress": progress,
    "--sky-radius": `${progress * 28}px`,
    "--sky-mark-y": `${-14 * (1 - progress)}px`,
  } as CSSProperties;

  return <>
    {preview && enabled && <aside className="sky-preview-tools" aria-label="天幕动效预览">
      <span>天幕下拉<span className="sky-preview-hint"> · 在首页空白处向下拖动</span></span>
      <div>
        <button onClick={play} disabled={busy || phase !== "idle"}>播放动效</button>
        <button onClick={toggleHeld} aria-pressed={phase === "held"}
          disabled={busy || !["idle", "held"].includes(phase)}>{phase === "held" ? "收起天幕" : "定格展开"}</button>
      </div>
    </aside>}
    <div ref={surface} className="sky-refresh" data-phase={enabled ? phase : "idle"} style={style}>
      <div className="sky-refresh-scene" aria-hidden="true">
        <div className="sky-refresh-light" />
        <div className="sky-refresh-center">
          <div className="sky-refresh-mark"><img src={polestar} alt="" width="48" height="48" draggable="false" /></div>
          <span className="sky-refresh-progress"><span /></span>
        </div>
      </div>
      <div className="sky-refresh-sheet">{children}</div>
      <span className="sky-refresh-announcement" role="status" aria-live="polite">{active && phase !== "closing" ? label : ""}</span>
    </div>
  </>;
}
