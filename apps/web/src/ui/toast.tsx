import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';

/**
 * Notifications éphémères (toasts).
 *
 * lticket n'a pas de composant « toast » générique ; son seul avis flottant est le préavis de
 * déconnexion `.session-preavis` (apps/console/src/styles.css l. 667-689) : en bas à droite,
 * 420 px max, rayon 10 px, bordure slate 200, ombre portée, entrée 160 ms. On en reprend
 * exactement le gabarit — il doit être vu sans bloquer le formulaire en cours.
 *
 * Accessibilité : région `aria-live` polie (succès/info) ; une erreur est annoncée en
 * `role="alert"`. Chaque toast a un bouton « Fermer » ; la disparition automatique est
 * désactivée pour les erreurs (le temps de lecture ne doit pas être imposé — WCAG 2.2.1).
 */
export type ToastTone = 'success' | 'info' | 'warn' | 'danger';
type ToastItem = { id: number; tone: ToastTone; message: ReactNode };

const TONE: Record<ToastTone, { icon: IconName; className: string }> = {
  success: { icon: 'checkCircle', className: 'text-success' },
  info: { icon: 'info', className: 'text-info' },
  warn: { icon: 'alert', className: 'text-warn' },
  danger: { icon: 'alertCircle', className: 'text-danger' },
};

type ToastApi = { show: (message: ReactNode, tone?: ToastTone) => void };
const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children, duration = 5000 }: { children: ReactNode; duration?: number }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((message: ReactNode, tone: ToastTone = 'success') => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { id, tone, message }]);
  }, []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[1000] flex max-w-[420px] flex-col gap-2.5">
        {items.map((t) => (
          <Toast key={t.id} item={t} duration={duration} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, duration, onDismiss }: { item: ToastItem; duration: number; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (item.tone === 'danger') return;
    const t = setTimeout(() => onDismiss(item.id), duration);
    return () => clearTimeout(t);
  }, [item, duration, onDismiss]);
  const tone = TONE[item.tone];
  return (
    <div
      role={item.tone === 'danger' ? 'alert' : 'status'}
      className="anim-toast pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3.5 text-sm text-ink shadow-[0_8px_24px_rgb(0_0_0/18%)]"
    >
      <span className={`mt-0.5 ${tone.className}`}><Icon name={tone.icon} /></span>
      <div className="min-w-0 flex-1">{item.message}</div>
      <button
        type="button"
        aria-label="Fermer la notification"
        onClick={() => onDismiss(item.id)}
        className="rounded p-0.5 text-ink-faint hover:bg-slate-100 hover:text-ink"
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Accès aux toasts. Hors fournisseur, l'appel est sans effet (écrans testés isolément). */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
const NOOP: ToastApi = { show: () => undefined };
