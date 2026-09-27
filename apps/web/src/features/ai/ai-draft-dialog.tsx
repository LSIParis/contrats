import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, errorMessage } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { invalidateContent } from '../structure/structure-api.js';
import { AiPrivacyNotice, AiSources } from './ai-notice.js';
import type { DraftResult } from './ai-api.js';

/**
 * « Rédiger avec l'IA » (brief §6, lot 6) : besoin, services, mode. Les
 * clauses produites sont enregistrées en nouvelle version, marquées
 * « générée par IA » et À REVOIR une par une avant toute soumission.
 */
export function AiDraftDialog({ contractId, provider, disabledReason, hasClauses }: {
  contractId: string;
  provider: string | null | undefined;
  disabledReason: string | null;
  hasClauses: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [needs, setNeeds] = useState('');
  const [services, setServices] = useState('');
  const [contractType, setContractType] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>(hasClauses ? 'append' : 'replace');
  const [formError, setFormError] = useState<string | null>(null);

  const draft = useMutation({
    mutationFn: () => apiPost<DraftResult>(`/v1/contracts/${contractId}/ai/draft`, {
      needs: needs.trim(),
      services: services.split('\n').map((s) => s.trim()).filter(Boolean),
      ...(contractType.trim() ? { contractType: contractType.trim() } : {}),
      mode,
    }),
    onSuccess: () => invalidateContent(qc, contractId),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (needs.trim().length < 10) {
      setFormError('Décrivez le besoin (10 caractères au moins).');
      return;
    }
    draft.mutate();
  }
  const close = () => { setOpen(false); draft.reset(); };
  const r = draft.data;

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} disabled={!!disabledReason} title={disabledReason ?? undefined}>
        Rédiger avec l’IA
      </Button>
      <Modal open={open} onClose={close} title="Rédiger avec l’IA" width={640}>
        {r ? (
          <div className="flex flex-col gap-3 text-sm">
            <p role="status" className="text-success">
              Version {r.versionNumber} enregistrée : {r.unreviewedAiClauses} clause(s) générée(s) par IA à faire valider par un juriste.
            </p>
            {r.suggestedAnnexes.length > 0 && (
              <div>
                <p className="font-button text-ink">Annexes suggérées</p>
                <ul className="ml-4 list-disc">{r.suggestedAnnexes.map((a) => <li key={a.title}><strong>{a.title}</strong> — {a.description}</li>)}</ul>
              </div>
            )}
            <AiSources sources={r.sources} warnings={r.warnings} />
            <div><Button type="button" onClick={close}>Fermer</Button></div>
          </div>
        ) : (
          <form noValidate onSubmit={submit} className="flex flex-col gap-3">
            <AiPrivacyNotice provider={provider} />
            <Field label="Besoin du client" htmlFor="ai-needs" error={formError ?? undefined}
              hint="Contexte, périmètre, contraintes (SLA, horaires, données hébergées…).">
              <textarea id="ai-needs" rows={4} className={controlClass} value={needs} maxLength={8000} onChange={(e) => setNeeds(e.target.value)} />
            </Field>
            <Field label="Services (un par ligne)" htmlFor="ai-services">
              <textarea id="ai-services" rows={3} className={controlClass} value={services} onChange={(e) => setServices(e.target.value)} />
            </Field>
            <Field label="Type de contrat (facultatif)" htmlFor="ai-type" hint="Par défaut : catégorie et titre du contrat.">
              <Input id="ai-type" value={contractType} maxLength={200} onChange={(e) => setContractType(e.target.value)} />
            </Field>
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 text-xs+ font-button text-ink-muted">Clauses existantes</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="ai-mode" value="append" checked={mode === 'append'} onChange={() => setMode('append')} />
                Ajouter les clauses générées à la suite des clauses existantes
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="ai-mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                Remplacer toutes les clauses existantes
              </label>
            </fieldset>
            {draft.error && <p role="alert" className="text-sm text-danger">{errorMessage(draft.error)}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={draft.isPending}>{draft.isPending ? 'Rédaction en cours…' : 'Lancer la rédaction'}</Button>
              <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
