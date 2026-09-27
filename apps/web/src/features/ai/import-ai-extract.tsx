import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, errorMessage } from '../../lib/api.js';
import { formatEuros } from '../../lib/money.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { AiPrivacyNotice, AiUnavailable } from './ai-notice.js';
import { aiUnavailableReason, useAiAvailability } from './ai-api.js';

interface ExtractedField {
  value: unknown;
  confidence: number;
  evidence: { excerpt: string } | null;
  method?: string;
}
interface ImportExtractResult {
  provider: string;
  added: string[];
  warnings: string[];
  extraction: Record<string, ExtractedField | null | undefined>;
}

const FIELD_FR: Record<string, string> = {
  dateSignature: 'Date de signature',
  dateEffet: 'Date d’effet',
  dureeMois: 'Durée initiale',
  reconduction: 'Reconduction',
  preavis: 'Préavis',
  montantMensuelHtCentimes: 'Montant mensuel HT',
  montantAnnuelHtCentimes: 'Montant annuel HT',
  indiceRevision: 'Indice de révision',
};

function render(key: string, v: unknown): string {
  if (v == null) return '—';
  if (key.endsWith('Centimes') && typeof v === 'number') return formatEuros(v);
  if (key === 'dureeMois') return `${String(v)} mois`;
  if (key === 'preavis' && typeof v === 'object') {
    const p = v as { quantite?: number; unite?: string };
    return `${p.quantite ?? '?'} ${String(p.unite ?? '').toLowerCase()}`;
  }
  if (/^date/.test(key) && typeof v === 'string') return new Date(`${v}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' });
  return String(v);
}

/**
 * « Compléter avec l'IA » sur l'écran de validation d'un import (lot 6) :
 * complète UNIQUEMENT les champs que les règles locales n'ont pas trouvés,
 * chacun adossé à un extrait exact du document. Rien n'est validé d'office.
 */
export function ImportAiExtract({ contractId, ocrReady }: { contractId: string; ocrReady: boolean }) {
  const qc = useQueryClient();
  const ai = useAiAvailability();
  const reason = ai.isLoading ? 'Vérification de la disponibilité de l’IA…' : aiUnavailableReason(ai.data);
  const m = useMutation({
    mutationFn: () => apiPost<ImportExtractResult>(`/v1/contracts/${contractId}/import/ai-extract`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['import', contractId] }); },
  });
  const disabled = !!reason || !ocrReady || m.isPending;

  return (
    <section aria-labelledby="imp-ai-title" className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <h2 id="imp-ai-title" className="text-15 font-title text-ink">Extraction assistée par IA</h2>
      {reason ? <AiUnavailable reason={reason} /> : <AiPrivacyNotice provider={ai.data?.provider} />}
      {!ocrReady && <p className="text-13 text-ink-muted">Disponible une fois le texte du document extrait (OCR terminé).</p>}
      <div>
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => m.mutate()}>
          {m.isPending ? 'Analyse en cours…' : 'Compléter avec l’IA'}
        </Button>
      </div>
      {m.error && <p role="alert" className="text-danger">{errorMessage(m.error)}</p>}
      {m.data && (
        <div role="status" className="flex flex-col gap-2">
          {m.data.added.length === 0 ? (
            <p className="text-ink-muted">Aucun champ supplémentaire trouvé : les valeurs sans extrait vérifiable ont été écartées.</p>
          ) : (
            <>
              <p className="text-success">{m.data.added.length} champ(s) complété(s) par l’IA — à vérifier avant validation :</p>
              <ul className="flex flex-col gap-2">
                {m.data.added.map((k) => {
                  const f = m.data!.extraction[k];
                  return (
                    <li key={k} className="rounded border border-line px-3 py-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-button text-ink">{FIELD_FR[k] ?? k}</span> : {render(k, f?.value)}
                        <Badge tone="warn">IA (LLM)</Badge>
                        {f && <Badge tone="neutral">Confiance {Math.round(f.confidence * 100)} %</Badge>}
                      </p>
                      {f?.evidence?.excerpt && (
                        <blockquote className="mt-1 border-l-2 border-line-strong pl-2 text-13 italic text-ink-muted">
                          <span className="sr-only">Extrait du document : </span>« {f.evidence.excerpt} »
                        </blockquote>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {m.data.warnings.length > 0 && <ul className="ml-4 list-disc text-13 text-warn">{m.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
