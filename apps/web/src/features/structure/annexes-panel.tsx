import { Link } from 'react-router-dom';
import { annexKindLabel } from '../../lib/labels.js';
import { Badge } from '../../ui/badge.js';
import { Card } from '../../ui/card.js';
import { Spinner } from '../../ui/spinner.js';
import { GENERATED_ANNEXES, GeneratedAnnexNote } from './annexes-editor.js';
import { useStructure } from './structure-api.js';

/** Onglet « Annexes » : lecture des annexes de la version courante. */
export function AnnexesPanel({ contractId, editable }: { contractId: string; editable: boolean }) {
  const s = useStructure(contractId);
  if (s.isLoading) return <Spinner />;
  if (s.error || !s.data) return <p role="alert" className="text-sm text-danger">Annexes indisponibles.</p>;
  const annexes = s.data.annexes;
  return (
    <Card title="Annexes" actions={editable ? <Link to={`/contracts/${contractId}/structure`} className="text-sm text-primary hover:underline">Modifier les annexes</Link> : undefined}>
      {annexes.length === 0 ? (
        <p className="text-sm text-ink-faint">Aucune annexe.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {annexes.map((a, i) => (
            <li key={a.id} className="flex flex-col gap-2 rounded border border-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-title text-ink">Annexe {i + 1} — {a.title}</h3>
                <Badge tone="muted">{annexKindLabel(a.kind)}</Badge>
              </div>
              {a.bodyHtml
                ? <div className="prose max-w-none text-sm" dangerouslySetInnerHTML={{ __html: a.bodyHtml }} />
                : GENERATED_ANNEXES.includes(a.kind)
                  ? <GeneratedAnnexNote annex={a} />
                  : <p className="text-sm text-ink-faint">Annexe sans texte.</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
