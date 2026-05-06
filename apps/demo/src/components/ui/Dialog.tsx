import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
  maxWidth?: string; // e.g. "max-w-2xl"
  /** Drop the built-in header (title row + X close button). The caller
   *  must provide its own close affordance somewhere inside `children`,
   *  otherwise the only way out is Escape or backdrop click. */
  hideHeader?: boolean;
}

export const Dialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
  children,
  title,
  className,
  maxWidth = "max-w-md",
  hideHeader = false,
}) => {
  const titleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const lastActiveElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      lastActiveElRef.current = document.activeElement as HTMLElement | null;
      document.body.style.overflow = "hidden";
      // Move focus into the dialog for keyboard users
      setTimeout(() => closeBtnRef.current?.focus(), 0);
    } else {
      document.body.style.overflow = "unset";
      // Restore focus back to the trigger (best-effort)
      setTimeout(() => lastActiveElRef.current?.focus?.(), 0);
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
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

      {/* Dialog Panel */}
      <div
        className={cn(
          "panel relative w-full animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col",
          maxWidth,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header (optional) */}
        {!hideHeader && (
          <div className="flex items-center justify-between p-4 border-b border-[#2a2a28]">
            {title ? (
              <h2
                id={titleId}
                className="text-base font-semibold text-[var(--text)] tracking-tight"
              >
                {title}
              </h2>
            ) : (
              <div />
            )}
            <button
              onClick={onClose}
              ref={closeBtnRef}
              className="p-2 text-[#706b63] hover:text-[#e8e5e0] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Close dialog"
            >
              <X size={20} />
            </button>
          </div>
        )}

        {/* Content */}
        <div
          className={cn(
            "overflow-y-auto custom-scrollbar",
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
