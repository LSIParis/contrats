import { useId, useState } from 'react';
import { RichText } from './rich-text.js';

/**
 * Description riche (HTML) d'un code tarif, d'une ligne de proposition ou de
 * barème : éditeur mis en forme (TipTap) ou saisie du HTML source. Le HTML est
 * ASSAINI côté serveur à l'enregistrement (liste blanche) ; l'affichage passe
 * par `HtmlBlock`.
 */
export const HTML_MAX = 20000;

/** '' pour un éditeur vide (`<p></p>`, blancs) : l'appelant envoie alors null / rien. */
export function emptyHtml(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s === '' || /^(<p>\s*(<br\s*\/?>)?\s*<\/p>)+$/i.test(s) ? '' : s;
}

const fmt = (n: number) => n.toLocaleString('fr-FR').replace(/\s/g, ' ');

export function HtmlField({ label, value, onChange, maxLength = HTML_MAX, hint }: {
  label: string;
  value: string;
  onChange: (html: string) => void;
  maxLength?: number;
  hint?: string;
}) {
  const uid = useId();
  const [source, setSource] = useState(false);
  const over = value.length > maxLength;
  const tab = (on: boolean) =>
    `rounded px-2 py-1 text-xs font-button ${on ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`;
  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${uid}-label`} className="text-xs+ font-button text-ink-muted">{label}</span>
        <div className="inline-flex gap-1 rounded border border-line bg-slate-50 p-0.5" role="group" aria-label={`Mode d’édition — ${label}`}>
          <button type="button" className={tab(!source)} aria-pressed={!source} onClick={() => setSource(false)}>Texte mis en forme</button>
          <button type="button" className={tab(source)} aria-pressed={source} onClick={() => setSource(true)}>HTML source</button>
        </div>
      </div>
      {source ? (
        <textarea
          aria-label={`${label} (HTML source)`}
          rows={10}
          spellCheck={false}
          className="w-full rounded border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-ink"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <RichText label={label} value={value} onChange={onChange} />
      )}
      <div className="flex flex-wrap justify-between gap-2 text-xs">
        <span className="text-ink-faint">{hint ?? ''}</span>
        <span className={over ? 'font-button text-danger' : 'text-ink-faint'} aria-live="polite">
          {fmt(value.length)} / {fmt(maxLength)}{over ? ' — trop long' : ''}
        </span>
      </div>
    </div>
  );
}

/** HTML stocké (assaini par le serveur) affiché en pleine largeur ; `className` remplace la taille par défaut (`text-sm`). */
export function HtmlBlock({ html, className = 'text-sm' }: { html: string; className?: string }) {
  return <div className={`prose max-w-none ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
