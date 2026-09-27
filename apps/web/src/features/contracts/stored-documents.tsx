import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';

export interface StoredDocumentItem {
  id: string;
  kind: string;
  label: string;
  origin: string;
  filename: string;
  contentType: string;
  sizeBytes: string;
  sha256: string;
  createdAt: string;
}

const size = (bytes: string) => {
  const n = Number(bytes);
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;
};

/**
 * Pièces conservées du contrat (preuves de signature, courriers de résiliation,
 * copies OCR…) avec leur empreinte SHA-256, qui fonde leur valeur probante.
 */
export function StoredDocuments({ contractId }: { contractId: string }) {
  const q = useQuery({
    queryKey: ['contract-documents', contractId],
    queryFn: () => apiGet<{ items: StoredDocumentItem[] }>(`/v1/contracts/${contractId}/documents`),
  });
  if (q.isLoading) return <p className="text-sm text-ink-faint">Chargement des pièces…</p>;
  if (q.isError) return <p className="text-sm text-danger">Pièces indisponibles.</p>;
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section aria-label="Pièces conservées" className="flex flex-col gap-2">
      <h3 className="font-medium text-ink">Pièces conservées</h3>
      <ul className="flex flex-col gap-2 text-sm">
        {items.map((d) => (
          <li key={d.id} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium text-ink">{d.label}</span>
              <a href={`/v1/contracts/${contractId}/documents/${d.id}`} className="text-primary hover:underline">
                {d.filename}
              </a>
              <span className="text-ink-faint">{size(d.sizeBytes)} · {new Date(d.createdAt).toLocaleDateString('fr-FR')}</span>
            </span>
            <span className="font-mono text-xs text-ink-faint" title="Empreinte SHA-256">SHA-256 {d.sha256}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
