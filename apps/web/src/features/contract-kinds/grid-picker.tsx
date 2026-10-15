import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { contractKindsApi } from './api.js';
import { euros, recurrenceLabel, unitLabel } from './labels.js';
import type { VariantSnapshot } from './types.js';

/**
 * Sélecteur de codes tarifs (versions par durée d'engagement) pour les lignes
 * des documents : modèles de propositions, propositions, barèmes de contrat,
 * devis (docs/contrats/13-types-contrats.md §7).
 *
 * Filtres : type de contrat, durée, texte (code ou libellé). `defaultMonths`
 * présélectionne la durée du document ; seules les versions proposées ayant
 * un prix en vigueur sont listées. Ce que renvoie `onPick` est COPIÉ par
 * l'appelant dans la ligne (code, libellé, prix, TVA).
 */
export function GridPicker({
  open,
  onClose,
  onPick,
  title = 'Choisir dans la grille tarifaire',
  defaultMonths = null,
  pending = false,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (v: VariantSnapshot) => void;
  title?: string;
  defaultMonths?: number | null;
  pending?: boolean;
  error?: unknown;
}) {
  const uid = useId();
  const [kindId, setKindId] = useState('');
  const [months, setMonths] = useState<string>(defaultMonths === null ? '' : String(defaultMonths));
  const [q, setQ] = useState('');
  const kinds = useQuery({ queryKey: ['contract-kinds', false], queryFn: () => contractKindsApi.list(false), enabled: open });
  const terms = useQuery({ queryKey: ['commitment-terms', false], queryFn: () => contractKindsApi.terms(false), enabled: open });
  const params = new URLSearchParams();
  if (kindId) params.set('kindId', kindId);
  if (months !== '') params.set('months', months);
  if (q.trim()) params.set('q', q.trim());
  const search = useQuery({
    queryKey: ['price-grid-variants', kindId, months, q.trim()],
    queryFn: () => apiRequest<{ on: string; items: VariantSnapshot[] }>('GET', `/v1/price-grid/variants?${params.toString()}`),
    enabled: open,
  });
  return (
    <Modal open={open} onClose={onClose} title={title} width={860}>
      <div className="grid grid-cols-[1fr_1fr_2fr] gap-3">
        <Field label="Type de contrat" htmlFor={`${uid}-kind`}>
          <Select id={`${uid}-kind`} value={kindId} onChange={(e) => setKindId(e.target.value)}>
            <option value="">Tous les types</option>
            {kinds.data?.items.map((k) => <option key={k.id} value={k.id}>{k.label} ({k.prefix})</option>)}
          </Select>
        </Field>
        <Field label="Durée d'engagement" htmlFor={`${uid}-months`}>
          <Select id={`${uid}-months`} value={months} onChange={(e) => setMonths(e.target.value)}>
            <option value="">Toutes les durées</option>
            {terms.data?.items.map((t) => <option key={t.months} value={String(t.months)}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Rechercher" htmlFor={`${uid}-q`} hint="Code (ex. M365-0003) ou libellé.">
          <Input id={`${uid}-q`} value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
      </div>
      {error ? <ErrorNote>{errorText(error)}</ErrorNote> : null}
      {search.isLoading ? <Spinner /> : search.error ? <ErrorNote>{errorText(search.error)}</ErrorNote> : (
        <Table head={['Code', 'Libellé', 'Durée', 'Prix HT', 'Unité', 'TVA', '']} caption="Codes tarifs proposés">
          {search.data?.items.length ? search.data.items.map((v) => (
            <tr key={v.code}>
              <td className="font-mono text-xs">{v.code}</td>
              <td>{v.label}<div className="text-xs text-ink-muted">{v.kind.label}</div></td>
              <td>{v.termLabel}</td>
              <td className="text-right">{euros(v.unitPrice)}<div className="text-xs text-ink-muted">{recurrenceLabel(v.recurrence)}</div></td>
              <td>{unitLabel(v.unit)}</td>
              <td>{v.vatRatePercent} %</td>
              <td><Button size="sm" variant="secondary" disabled={pending} onClick={() => onPick(v)}>Choisir</Button></td>
            </tr>
          )) : (
            <tr><td colSpan={7} className="text-ink-muted">Aucun code proposé pour ces critères.</td></tr>
          )}
        </Table>
      )}
    </Modal>
  );
}
