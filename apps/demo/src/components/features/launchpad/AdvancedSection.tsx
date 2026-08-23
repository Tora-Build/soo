// A disclosure for the controls that have a right answer.
//
// The rule's endpoint, path, comparator, threshold and scale are all drafted
// and then verified against the live response, so for almost every creator the
// correct action is to leave them alone. Shown by default they read as five
// decisions to make before launching; hidden, they are still one click away for
// the creator who has a source in mind and wants to test it.
//
// Closed is the default and the summary line is the whole affordance: it says
// what is inside without the creator having to open it to find out.

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";

interface Props {
  label: string;
  /** Rendered beside the label while closed — what is in there, in a few words. */
  summary?: ReactNode;
  children: ReactNode;
}

export const AdvancedSection = ({ label, summary, children }: Props) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-rule bg-inset">
      <button
        type="button"
        data-testid="launchpad-advanced-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-muted hover:text-ink transition-colors"
      >
        <ChevronRight
          className={cn(
            "w-4 h-4 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-sm font-semibold">{label}</span>
        {!open && summary && (
          <span className="ml-auto truncate text-sm text-faint">{summary}</span>
        )}
      </button>

      {open && (
        <div
          data-testid="launchpad-advanced-body"
          className="space-y-4 border-t border-rule p-3"
        >
          {children}
        </div>
      )}
    </div>
  );
};
