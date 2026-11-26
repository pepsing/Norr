import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export function Modal({
  title,
  onClose,
  children,
  className = "",
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const drag = useRef<{ id: number; y: number } | null>(null);
  const closing = useRef<Animation | null>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  function dismiss() {
    const dialog = ref.current;
    if (!dialog || closing.current) return;
    if (!document.documentElement.classList.contains("native-ios") ||
        matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    const start = getComputedStyle(dialog).translate;
    const offset = dialog.style.translate.split(" ")[1];
    const end = (parseFloat(offset) || 0) + 28;
    const animation = dialog.animate([
      { translate: start, opacity: 1 },
      { translate: "0 " + end + "px", opacity: 0 },
    ], { duration: 140, easing: "ease-in" });
    closing.current = animation;
    animation.onfinish = () => {
      closing.current = null;
      dialog.style.removeProperty("translate");
      latestClose.current();
    };
  }

  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const bodyStyle = document.body.style;
    const previousStyle = {
      overflow: bodyStyle.overflow,
      position: bodyStyle.position,
      top: bodyStyle.top,
      left: bodyStyle.left,
      width: bodyStyle.width,
    };
    const root = document.documentElement;
    const rootOverflow = root.style.overflow;
    const ios = root.classList.contains("native-ios");
    if (ios) root.style.overflow = "hidden";
    else Object.assign(bodyStyle, {
      overflow: "hidden",
      position: "fixed",
      top: `${-scrollY}px`,
      left: `${-scrollX}px`,
      width: "100%",
    });
    if (!ios) window.scrollTo(0, 0);
    dialog.showModal();
    return () => {
      closing.current?.cancel();
      closing.current = null;
      dialog.close();
      if (ios) root.style.overflow = rootOverflow;
      Object.assign(bodyStyle, previousStyle);
      window.scrollTo(scrollX, scrollY);
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          ) {
            dismiss();
          }
        }
      }}
    >
      <div className="modal-heading"
        onPointerDown={event => {
          if (event.pointerType !== "touch" || !event.isPrimary || closing.current ||
              !document.documentElement.classList.contains("native-ios") ||
              (event.target as Element).closest("button")) return;
          drag.current = { id: event.pointerId, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (drag.current?.id !== event.pointerId) return;
          if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
            ref.current!.style.translate = `0 ${Math.max(0, event.clientY - drag.current.y)}px`;
        }}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          const distance = event.clientY - drag.current.y;
          drag.current = null;
          if (distance >= 64) dismiss();
          if (!closing.current) ref.current?.style.removeProperty("translate");
        }}
        onLostPointerCapture={event => {
          if (drag.current?.id !== event.pointerId) return;
          drag.current = null;
          ref.current?.style.removeProperty("translate");
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label="关闭对话框"
          onClick={dismiss}
        >
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
