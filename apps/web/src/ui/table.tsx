import type { ReactNode } from 'react';

/**
 * Tableau — `table` de lticket (apps/console/src/styles.css l. 309-325) :
 * en-têtes 12 px, graisse 600, capitales espacées, ton `--text-faint` ; cellules 11×12 px
 * séparées par la bordure slate 200 ; survol de ligne slate 50. Le tableau défile DANS son
 * conteneur (`.table-wrap`, l. 313) au lieu de déborder de la carte.
 *
 * Les règles visent les `th`/`td` descendants : les pages n'ont rien à répéter.
 */
const TABLE_CLASS = [
  'w-full border-collapse text-sm',
  '[&_thead_th]:border-b [&_thead_th]:border-line [&_thead_th]:px-3 [&_thead_th]:py-2.5 [&_thead_th]:text-left',
  '[&_thead_th]:text-xs [&_thead_th]:font-semibold [&_thead_th]:uppercase [&_thead_th]:tracking-[.03em] [&_thead_th]:text-ink-faint',
  '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:px-3 [&_tbody_td]:py-[11px] [&_tbody_td]:text-left',
  '[&_tbody_tr:hover]:bg-slate-50',
].join(' ');

export function Table({ head, children, caption }: { head: ReactNode; children: ReactNode; caption?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={TABLE_CLASS}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
