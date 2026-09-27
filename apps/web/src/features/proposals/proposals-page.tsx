import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, errorMessage } from '../../lib/api.js';
import { formatCents } from '../../lib/money.js';
import { allows } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { NewProposalDialog, type CustomerOption } from './new-proposal-dialog.js';
import { PROPOSAL_STATUSES, proposalsApi } from './proposal-api.js';
import { COMMERCIAL_STATUS_LABELS, formatDateTime, formatDay, PROPOSAL_STATUS_LABELS, ProposalStatusBadge } from './proposal-labels.js';
import { useProposalStream } from './use-proposal-stream.js';
import { ProposalViewsNav } from './reports/proposal-reports-pages.js';

/**
 * Liste des propositions commerciales (brief §12, §11) : filtres statut /
 * client / « mes propositions », création (client existant ou nouveau
 * prospect, modèle de l'annexe C, mode d'acceptation). Montants : synthèse
 * calculée par le serveur, seulement formatée ici.
 */
export function ProposalsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['proposals', status, customerId, mine],
    queryFn: () => proposalsApi.list({ status, customerId, mine }),
  });
  const customers = useQuery({ queryKey: ['customers'], queryFn: () => apiGet<{ items: CustomerOption[] }>('/v1/customers') });
  // Temps réel : une proposition consultée, acceptée, signée… rafraîchit la liste.
  useProposalStream(() => void qc.invalidateQueries({ queryKey: ['proposals'] }));

  const canCreate = allows(me.data, 'proposals.write');
  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-22">Propositions commerciales</h1>
        {canCreate && <Button onClick={() => setCreating(true)}>Nouvelle proposition</Button>}
      </div>
      <ProposalViewsNav />

      <Card>
        <div className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,220px))] sm:items-end">
          <Field label="Statut" htmlFor="filtre-statut">
            <Select id="filtre-statut" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Tous les statuts</option>
              {PROPOSAL_STATUSES.map((s) => <option key={s} value={s}>{PROPOSAL_STATUS_LABELS[s]}</option>)}
            </Select>
          </Field>
          <Field label="Client" htmlFor="filtre-client">
            <Select id="filtre-client" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Tous les clients</option>
              {(customers.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <label className="inline-flex items-center gap-2 pb-2 text-sm text-ink">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            Mes propositions
          </label>
        </div>
      </Card>

      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote>{errorMessage(list.error, 'Liste indisponible.')}</ErrorNote>
      ) : items.length === 0 ? (
        <Card><p className="text-sm text-ink-muted">Aucune proposition pour ces critères.</p></Card>
      ) : (
        <Card>
          <Table
            caption="Propositions commerciales"
            head={
              <tr>
                <th scope="col">Numéro</th><th scope="col">Titre</th><th scope="col">Client</th><th scope="col">Statut</th>
                <th scope="col">Mensuel HT</th><th scope="col">Total engagement HT</th><th scope="col">Échéance</th>
                <th scope="col">Commercial</th><th scope="col">Dernière activité</th>
              </tr>
            }
          >
            {items.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/proposals/${p.id}`} className="font-button text-primary hover:underline">{p.number}</Link></td>
                <td>{p.title}</td>
                <td>
                  <span className="flex flex-wrap items-center gap-2">
                    {p.customer.name}
                    {p.customer.commercialStatus === 'PROSPECT' && <Badge tone="muted">{COMMERCIAL_STATUS_LABELS.PROSPECT}</Badge>}
                  </span>
                </td>
                <td><ProposalStatusBadge status={p.status} /></td>
                <td className="tabular-nums">{formatCents(p.monthlyCents === null ? null : String(p.monthlyCents))}</td>
                <td className="tabular-nums">
                  <span>{formatCents(p.commitmentTotalCents === null ? null : String(p.commitmentTotalCents))}</span>
                  {p.commitmentMonths ? <span className="text-ink-faint"> / {p.commitmentMonths} mois</span> : null}
                </td>
                <td>{formatDay(p.expiresAt)}</td>
                <td>{p.owner?.fullName ?? '—'}</td>
                <td>{formatDateTime(p.lastActivityAt)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {creating && <NewProposalDialog onClose={() => setCreating(false)} customers={customers.data?.items ?? []} canCreateCustomer={allows(me.data, 'customers.write')} />}
    </div>
  );
}
