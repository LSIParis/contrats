import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.js';

/**
 * Boîte de dialogue modale — reprise de lticket (apps/console/src/components/Dialog.tsx ;
 * voile `.modal-fond` styles.css l. 746-751).
 *
 * - Montée dans `document.body` par portal : aucun ancêtre transformé ne peut l'enfermer.
 * - `role="dialog"`, `aria-modal`, titre relié par `aria-labelledby`.
 * - Focus : placé sur le premier élément focusable (sinon sur la boîte), PIÉGÉ dans la boîte
 *   (Tab / Maj+Tab bouclent), rendu à l'élément d'origine à la fermeture.
 * - Échap ferme ; un clic sur le voile ferme ; le défilement de la page est bloqué.
 * - Placement `center` (défaut) ou `side` (tiroir à droite, comme le `Drawer` de lticket).
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  placement = 'center',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  placement?: 'center' | 'side';
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const lastFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === firstEl || activeEl === panelRef.current)) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && activeEl === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      lastFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  const centre = placement === 'center';

  return createPortal(
    <div
      className={`fixed inset-0 z-[200] flex bg-[var(--overlay)] ${centre ? 'items-center justify-center p-6' : 'items-stretch justify-end'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width: `min(${width}px, 100%)` }}
        className={`anim-dialog flex flex-col gap-3 overflow-y-auto bg-surface p-5 shadow-pop outline-none ${
          centre ? 'max-h-[calc(100vh-48px)] rounded-lg' : 'h-full'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-15 font-title text-ink">{title}</h2>
          <button
            type="button"
            aria-label="Fermer"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded border border-line-strong bg-surface p-1.5 text-ink hover:bg-slate-100"
          >
            <Icon name="close" />
          </button>
        </div>
        <div>{children}</div>
        {footer && <div className="mt-1.5 flex items-center justify-end gap-2.5 border-t border-line pt-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
