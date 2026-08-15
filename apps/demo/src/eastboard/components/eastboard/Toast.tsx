import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

/**
 * Transient confirmations.
 *
 * Terminal messages — "Order confirmed: 0x…" — used to sit in the inline
 * status line until something else overwrote them, so a receipt from the
 * previous step was still on screen while you started the next one. Those
 * belong in a toast: they are worth seeing once, then gone.
 *
 * The toast carries role="status" because that is what the live e2e suite
 * asserts on. Callers must clear their inline status when they push one, so
 * only a single role="status" node exists at a time — two would make
 * Playwright's strict locator ambiguous.
 */
export interface ToastMessage {
  id: number;
  text: string;
  href?: string;
}

interface ToastApi {
  push: (text: string, options?: { href?: string }) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Long enough to read a hash and for a slow assertion to catch it. */
const TOAST_TTL_MS = 20_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (text: string, options?: { href?: string }) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, text, href: options?.href }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), TOAST_TTL_MS),
      );
    },
    [dismiss],
  );

  const clear = useCallback(() => {
    for (const handle of timers.current.values()) window.clearTimeout(handle);
    timers.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) window.clearTimeout(handle);
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ push, clear }), [push, clear]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-modal flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              // Opaque on purpose: this floats over the board, and the soft
              // tokens are ~12% alpha, so a tinted background would let the
              // grid and cells read straight through the receipt.
              className="pointer-events-auto w-full max-w-[420px] border border-pos/50 bg-raised px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
            >
              <p className="break-all font-mono text-[10px] leading-relaxed text-pos">
                {toast.text}
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                {toast.href ? (
                  <a
                    href={toast.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted underline hover:text-ink"
                  >
                    {t("eastboard.toast.viewReceipt")}
                  </a>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint hover:text-ink"
                >
                  {t("eastboard.toast.dismiss")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
