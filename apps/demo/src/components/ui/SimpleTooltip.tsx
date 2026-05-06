import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

interface SimpleTooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
}

export const SimpleTooltip = ({
  content,
  children,
  className,
}: SimpleTooltipProps) => {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  let tooltipStyle: React.CSSProperties | undefined;
  if (show && ref.current) {
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    // Clamp so tooltip doesn't overflow viewport edges
    const left = Math.max(120, Math.min(centerX, window.innerWidth - 120));
    tooltipStyle = {
      position: "fixed",
      left,
      top: rect.top - 6,
      transform: "translate(-50%, -100%)",
      maxWidth: 240,
    };
  }

  return (
    <span
      ref={ref}
      className="inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show &&
        tooltipStyle &&
        createPortal(
          <span
            className={cn(
              "z-[9999] px-2.5 py-1.5",
              "bg-tooltip border border-rule text-[11px] text-ink leading-snug",
              "pointer-events-none",
              className,
            )}
            style={tooltipStyle}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
};
