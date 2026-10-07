/* Modal (native <dialog>), confirm dialog and toasts. */
import clsx from 'clsx';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';

/* ------------------------------ Modal ------------------------------ */

export function Modal({
  open,
  onClose,
  children,
  size = 'md',
  title,
  className,
  bare,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  title?: ReactNode;
  className?: string;
  /** no padding / header - caller renders everything */
  bare?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={clsx(
        'm-auto max-h-[92dvh] w-[calc(100%-1.5rem)] overflow-hidden rounded-2xl border border-line bg-card p-0 text-fg shadow-2xl backdrop:transition-opacity',
        width,
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          {!bare && (
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <h2 className="truncate text-base font-semibold">{title}</h2>
              <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-card-hover hover:text-fg" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
          )}
          <div className={clsx('min-h-0 flex-1 overflow-y-auto', !bare && 'p-5')}>{children}</div>
        </div>
      )}
    </dialog>
  );
}

/* ------------------------------ Toasts ------------------------------ */

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
}

interface ToastApi {
  success: (title: string, body?: ReactNode, action?: ToastItem['action']) => void;
  error: (title: string, body?: ReactNode) => void;
  info: (title: string, body?: ReactNode, action?: ToastItem['action']) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

/* ------------------------------ Confirm ------------------------------ */

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** optional checkboxes, returned in the result */
  checks?: { id: string; label: string; defaultChecked?: boolean }[];
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<false | Record<string, boolean>>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = ++seq.current;
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.tone === 'error' ? 8000 : 5000);
  }, []);
  const toastApi = useRef<ToastApi>({
    success: (title, body, action) => push({ tone: 'success', title, body, action }),
    error: (title, body) => push({ tone: 'error', title, body }),
    info: (title, body, action) => push({ tone: 'info', title, body, action }),
  }).current;

  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: false | Record<string, boolean>) => void }) | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise((resolve) => {
        setChecks(Object.fromEntries((opts.checks || []).map((c) => [c.id, !!c.defaultChecked])));
        setConfirmState({ ...opts, resolve });
      }),
    [],
  );
  const close = (v: false | Record<string, boolean>) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return (
    <ToastCtx.Provider value={toastApi}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <Modal open={!!confirmState} onClose={() => close(false)} size="sm" title={confirmState?.title}>
          {confirmState && (
            <div className="space-y-4">
              {confirmState.message && <div className="text-sm text-muted">{confirmState.message}</div>}
              {confirmState.checks?.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={!!checks[c.id]}
                    onChange={(e) => setChecks((s) => ({ ...s, [c.id]: e.target.checked }))}
                  />
                  {c.label}
                </label>
              ))}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => close(false)}>
                  Cancel
                </Button>
                <Button variant={confirmState.danger ? 'danger' : 'primary'} onClick={() => close(checks)} autoFocus>
                  {confirmState.confirmLabel || 'Confirm'}
                </Button>
              </div>
            </div>
          )}
        </Modal>
        <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5">
          {toasts.map((t) => {
            const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'error' ? CircleAlert : Info;
            return (
              <div key={t.id} role="status" className="toast-in pointer-events-auto flex w-full max-w-sm gap-3 rounded-xl border border-line bg-elev p-3.5 shadow-2xl sm:w-96">
                <Icon className={clsx('mt-0.5 size-5 shrink-0', t.tone === 'success' ? 'text-ok' : t.tone === 'error' ? 'text-bad' : 'text-info')} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{t.title}</div>
                  {t.body && <div className="mt-0.5 text-[13px] break-words text-muted">{t.body}</div>}
                  {t.action &&
                    (t.action.href ? (
                      <a href={t.action.href} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[13px] font-semibold text-accent hover:underline">
                        {t.action.label}
                      </a>
                    ) : (
                      <button type="button" onClick={t.action.onClick} className="mt-1.5 text-[13px] font-semibold text-accent hover:underline">
                        {t.action.label}
                      </button>
                    ))}
                </div>
                <button type="button" className="self-start text-subtle hover:text-fg" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))} aria-label="Dismiss">
                  <X className="size-4" />
                </button>
              </div>
            );
          })}
        </div>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const t = useContext(ToastCtx);
  if (!t) throw new Error('useToast outside provider');
  return t;
}

export function useConfirm(): ConfirmFn {
  const c = useContext(ConfirmCtx);
  if (!c) throw new Error('useConfirm outside provider');
  return c;
}
