import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
  hideHeader?: boolean;
  /** Tailwind max-width class, defaults to `max-w-md` (~448px). Use a wider
   *  variant like `max-w-5xl` for surfaces that need more horizontal room
   *  (e.g. trading terminals with multi-column layouts). */
  maxWidth?: string;
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  children,
  title,
  className,
  hideHeader,
  maxWidth = "max-w-md",
}) => {
  const titleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const lastActiveElRef = useRef<HTMLElement | null>(null);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (isOpen) {
      lastActiveElRef.current = document.activeElement as HTMLElement | null;
      document.body.style.overflow = "hidden";
      setTimeout(() => closeBtnRef.current?.focus(), 0);
    } else {
      document.body.style.overflow = "unset";
      setTimeout(() => lastActiveElRef.current?.focus?.(), 0);
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-inset/80 animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <div
        className={cn(
          "relative w-full h-full bg-raised border-l border-rule animate-in slide-in-from-right duration-300 flex flex-col",
          maxWidth,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {hideHeader ? (
          <button
            onClick={onClose}
            ref={closeBtnRef}
            className="absolute top-3 right-3 z-10 p-2 bg-raised/80 hover:bg-raised text-muted hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        ) : (
          <div className="flex items-center justify-between p-4 border-b border-rule bg-raised">
            <h2
              id={titleId}
              className="text-base font-semibold text-ink tracking-tight"
            >
              {title || "Menu"}
            </h2>
            <button
              onClick={onClose}
              ref={closeBtnRef}
              className="p-2 hover:bg-raised text-muted hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              aria-label="Close panel"
            >
              <X size={20} />
            </button>
          </div>
        )}

        {/* Content */}
        <div
          className={cn(
            "flex-1 overflow-y-auto custom-scrollbar",
            hideHeader ? "p-0" : "p-4",
          )}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
};
