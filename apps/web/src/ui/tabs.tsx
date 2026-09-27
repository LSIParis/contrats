import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Onglets — reprise de lticket (apps/console/src/components/Tabs.tsx ; styles.css l. 604-608).
 *
 * - Barre soulignée : onglet actif en primaire avec un trait de 2 px, les autres atténués.
 * - La barre PASSE À LA LIGNE plutôt que de masquer des onglets (choix documenté par lticket).
 * - Clavier (motif WAI-ARIA « tabs », activation automatique) : ←/→ changent d'onglet,
 *   Début/Fin vont au premier/dernier ; un seul onglet est tabulable (tabindex glissant).
 * - Le panneau est focusable (`tabIndex=0`) : Tab mène du tablist au contenu.
 */
export type TabDef = { id: string; label: ReactNode; badge?: ReactNode };

export function TabBar({
  tabs,
  active,
  onChange,
  label,
  idPrefix,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    const next = tabs[j];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="mb-4 mt-1 flex flex-wrap gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px inline-flex items-center whitespace-nowrap border-b-2 bg-transparent px-3.5 py-2.5 text-sm font-button ${
              selected ? 'border-primary text-primary' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {t.label}
            {t.badge != null && (
              <span className="ml-1.5 rounded-full bg-slate-100 px-[9px] py-0.5 text-xs font-semibold leading-[1.6] text-slate-600">{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, active, idPrefix, children }: { id: string; active: boolean; idPrefix: string; children: ReactNode }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}

/**
 * Forme compacte : barre + panneau actif. `panels` associe l'identifiant d'onglet à son contenu.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  label,
  panels,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  panels: Record<string, ReactNode>;
}) {
  const idPrefix = useId().replace(/:/g, '');
  return (
    <div>
      <TabBar tabs={tabs} active={active} onChange={onChange} label={label} idPrefix={idPrefix} />
      {tabs.map((t) => (
        <TabPanel key={t.id} id={t.id} active={t.id === active} idPrefix={idPrefix}>
          {panels[t.id]}
        </TabPanel>
      ))}
    </div>
  );
}
