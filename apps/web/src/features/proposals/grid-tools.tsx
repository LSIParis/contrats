import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiRequestError, errorText } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote } from '../../ui/region-card.js';
import { useToast } from '../../ui/toast.js';
import { contractKindsApi } from '../contract-kinds/api.js';
import { GridPicker } from '../contract-kinds/grid-picker.js';
import { proposalsApi, type DefChoice, type ProposalDetail } from './proposal-api.js';

/**
 * Grille tarifaire dans une proposition en brouillon (13-types-contrats.md §7) :
 *  - « Ajouter depuis la grille » : code, libellé, prix par durée et TVA
 *    COPIÉS par le serveur (une version par durée proposée) ;
 *  - « Durées proposées » : 0 (sans engagement), 12, 24, 36 mois… ; si des
 *    lignes viennent de la grille, l'utilisateur CONFIRME s'il faut les
 *    basculer vers les versions et prix des durées retenues.
 */
export function commitmentChoice(choices: readonly DefChoice[]): DefChoice | undefined {
  return choices.find((c) => c.options.some((o) => o.commitmentMonths !== undefined));
}

/** Détail d'erreur 422 du serveur (versions manquantes). */
function details(e: unknown): string[] {
  const body = e instanceof ApiRequestError ? (e.body as { details?: unknown }) : undefined;
  return Array.isArray(body?.details) ? (body!.details as string[]) : [];
}

export function GridTools({ detail, onDetail }: { detail: ProposalDetail; onDetail: (d: ProposalDetail) => void }) {
  const toast = useToast();
  const { proposal, version, quote } = detail;
  const def = version.pricingDefinition;
  const choice = commitmentChoice(def.choices);
  const currentMonths = choice?.options.find((o) => o.value === quote.choices[choice.key])?.commitmentMonths ?? null;
  const gridLines = def.lines.filter((l) => l.grid);

  const [picking, setPicking] = useState(false);
  const add = useMutation({
    mutationFn: (itemCode: string) => proposalsApi.addGridLine(proposal.id, { itemCode }),
    onSuccess: (d) => {
      setPicking(false);
      toast.show('Ligne ajoutée depuis la grille : prix copiés pour chaque durée proposée.', 'success');
      onDetail(d);
    },
  });

  const terms = useQuery({ queryKey: ['commitment-terms', false], queryFn: () => contractKindsApi.terms(false) });
  const proposed = choice?.options.map((o) => o.commitmentMonths ?? 0) ?? [];
  const proposedDefault = choice?.options.find((o) => o.default)?.commitmentMonths ?? proposed[0] ?? 0;
  const [months, setMonths] = useState<number[]>(proposed);
  const [defaultMonths, setDefaultMonths] = useState<number>(proposedDefault);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setMonths(proposed);
    setDefaultMonths(proposedDefault);
  }, [detail]);
  const changed = [...months].sort((a, b) => a - b).join(',') !== [...proposed].sort((a, b) => a - b).join(',') || defaultMonths !== proposedDefault;
  const setCommitments = useMutation({
    mutationFn: (switchGridLines: boolean) => proposalsApi.setCommitments(proposal.id, { months, defaultMonths, switchGridLines }),
    onSuccess: (d, switched) => {
      setConfirming(false);
      toast.show(switched ? 'Durées mises à jour : lignes de la grille basculées.' : 'Durées mises à jour.', 'success');
      onDetail(d);
    },
  });
  const apply = () => (gridLines.length ? setConfirming(true) : setCommitments.mutate(false));
  const toggle = (m: number) => {
    const next = months.includes(m) ? months.filter((x) => x !== m) : [...months, m].sort((a, b) => a - b);
    setMonths(next);
    if (!next.includes(defaultMonths) && next.length) setDefaultMonths(next[0]!);
  };
  const missing = details(setCommitments.error);

  return (
    <section aria-label="Grille tarifaire" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-title text-ink">Grille tarifaire et durées d’engagement</h3>
        <Button size="sm" variant="secondary" onClick={() => { add.reset(); setPicking(true); }}>Ajouter depuis la grille</Button>
      </div>

      {choice && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs-plus font-button text-ink-muted">Durées proposées au client (une par défaut)</legend>
          <div className="flex flex-wrap gap-3">
            {(terms.data?.items ?? []).map((t) => (
              <span key={t.months} className="flex items-center gap-2 rounded border border-line px-2 py-1 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={months.includes(t.months)} onChange={() => toggle(t.months)} />
                  {t.label}
                </label>
                <label className="flex items-center gap-1 text-xs text-ink-muted">
                  <input type="radio" name="duree-defaut" disabled={!months.includes(t.months)} checked={defaultMonths === t.months} onChange={() => setDefaultMonths(t.months)} />
                  par défaut
                </label>
              </span>
            ))}
          </div>
          <div>
            <Button size="sm" disabled={!changed || months.length === 0 || setCommitments.isPending} onClick={apply}>Appliquer les durées</Button>
          </div>
          {setCommitments.error && !confirming ? (
            <ErrorNote>
              {errorText(setCommitments.error)}
              {missing.length > 0 && <ul className="list-disc pl-5">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            </ErrorNote>
          ) : null}
        </fieldset>
      )}

      <GridPicker
        open={picking}
        onClose={() => setPicking(false)}
        defaultMonths={currentMonths}
        title="Ajouter une ligne depuis la grille tarifaire"
        pending={add.isPending}
        error={add.error ? new Error([errorText(add.error), ...details(add.error)].join(' — ')) : undefined}
        onPick={(v) => add.mutate(v.itemCode)}
      />

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Basculer les lignes de la grille ?"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>Annuler</Button>
            <Button variant="secondary" disabled={setCommitments.isPending} onClick={() => setCommitments.mutate(false)}>Conserver les prix copiés</Button>
            <Button disabled={setCommitments.isPending} onClick={() => setCommitments.mutate(true)}>Basculer vers les versions</Button>
          </div>
        }
      >
        <p className="text-sm">
          {gridLines.length} ligne(s) viennent de la grille ({gridLines.map((l) => l.grid!.itemCode).join(', ')}).
          Les basculer reprend, pour chaque durée retenue, la version correspondante et son prix en vigueur aujourd’hui.
          Sinon, les prix déjà copiés sont conservés et seules les nouvelles durées sont lues dans la grille.
        </p>
        {setCommitments.error ? (
          <ErrorNote>
            {errorText(setCommitments.error)}
            {missing.length > 0 && <ul className="list-disc pl-5">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          </ErrorNote>
        ) : null}
      </Modal>
    </section>
  );
}
