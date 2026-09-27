import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, errorMessage } from '../../../lib/api.js';
import { formatCents } from '../../../lib/money.js';
import { buttonClass, Button } from '../../../ui/button.js';
import { Card } from '../../../ui/card.js';
import { Input } from '../../../ui/input.js';
import { ErrorNote } from '../../../ui/region-card.js';
import { Select } from '../../../ui/select.js';
import { Spinner } from '../../../ui/spinner.js';
import { Table } from '../../../ui/table.js';
import { proposalAdminApi } from '../proposal-api.js';
import { DECLINE_REASON_LABELS, formatDay, formatDuration, proposalStatusLabel, ProposalStatusBadge } from '../proposal-labels.js';

/**
 * Pilotage commercial (brief §12.8, lot 9.8 ; 11-propositions.md §15) :
 * pipeline en colonnes ou en liste, tableau de bord et export CSV. Tous les
 * montants sont des chaînes de centimes calculées par le serveur, seulement
 * formatées ici (`formatCents`) ; aucun agrégat n'est recalculé côté navigateur.
 */

export interface PipelineItem {
  id: string; number: string; title: string; status: string; customer: { id: string; name: string };
  owner: { id: string; name: string | null }; template: { id: string | null; name: string; slug: string } | null;
  monthlyCents: string; amountCents: string; probability: number; weightedCents: string; expiresAt: string | null;
}
export interface Pipeline {
  columns: { status: string; count: number; amountCents: string; weightedCents: string }[];
  items: PipelineItem[];
  totals: { count: number; amountCents: string; weightedCents: string };
}
interface ConversionRow { key: string; label: string; sent: number; won: number; conversionRatePercent: number | null; wonMonthlyCents: string }
export interface Dashboard {
  period: { from: string; to: string };
  sent: number; won: number; lost: number; open: number;
  conversionRatePercent: number | null; decidedConversionRatePercent: number | null; averageDaysSentToSigned: number | null;
  signedRecurringMonthlyCents: string; signedOneTimeCents: string;
  byTemplate: ConversionRow[]; byOwner: ConversionRow[];
  mostReadSections: { sectionKey: string; opens: number; averageSeconds: number }[];
  declineReasons: { code: string; count: number }[];
  mostChosenOptions: { code: string; count: number }[];
}

const R = '/v1/proposal-reports';
const query = (params: Record<string, string>) => {
  const sp = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${String(n).replace('.', ',')} %`);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Sous-navigation des vues de propositions (liste, pipeline, tableau de bord). */
export function ProposalViewsNav() {
  const items: [string, string][] = [['/proposals', 'Liste'], ['/proposals/pipeline', 'Pipeline'], ['/proposals/dashboard', 'Tableau de bord']];
  return (
    <nav aria-label="Vues des propositions" className="flex flex-wrap gap-1 border-b border-line">
      {items.map(([to, label]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => `-mb-px border-b-2 px-3.5 py-2.5 text-sm font-button ${isActive ? 'border-primary text-primary' : 'border-transparent text-ink-muted hover:text-ink'}`}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-22">{title}</h1>
      <ProposalViewsNav />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function ProposalPipelinePage() {
  const [owner, setOwner] = useState('');
  const [template, setTemplate] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const q = useQuery({
    queryKey: ['proposal-pipeline', owner, template],
    queryFn: () => apiGet<Pipeline>(`${R}/pipeline${query({ ownerUserId: owner, templateId: template })}`),
  });
  // Options du filtre « commercial » : d'après le pipeline complet (non filtré).
  const all = useQuery({ queryKey: ['proposal-pipeline', '', ''], queryFn: () => apiGet<Pipeline>(`${R}/pipeline`) });
  const templates = useQuery({ queryKey: ['proposal-templates'], queryFn: proposalAdminApi.templates });
  const owners = [...new Map((all.data?.items ?? []).map((i) => [i.owner.id, i.owner.name ?? i.owner.id])).entries()];

  return (
    <Frame title="Pipeline des propositions">
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-[200px] flex-col gap-[5px]">
            <label htmlFor="pipe-commercial" className="text-xs+ font-button text-ink-muted">Commercial</label>
            <Select id="pipe-commercial" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Tous les commerciaux</option>
              {owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </div>
          <div className="flex min-w-[200px] flex-col gap-[5px]">
            <label htmlFor="pipe-modele" className="text-xs+ font-button text-ink-muted">Modèle</label>
            <Select id="pipe-modele" value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Tous les modèles</option>
              {(templates.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
          <div role="radiogroup" aria-label="Affichage" className="flex gap-4 pb-2 text-sm">
            <label className="inline-flex items-center gap-2"><input type="radio" name="pipe-vue" checked={view === 'board'} onChange={() => setView('board')} /> Colonnes</label>
            <label className="inline-flex items-center gap-2"><input type="radio" name="pipe-vue" checked={view === 'list'} onChange={() => setView('list')} /> Liste</label>
          </div>
        </div>
      </Card>

      {q.isLoading ? <Spinner /> : q.error || !q.data ? <ErrorNote>{errorMessage(q.error, 'Pipeline indisponible.')}</ErrorNote> : (
        <>
          <section aria-label="Totaux du pipeline" className="grid gap-3 rounded-lg border border-line bg-surface p-4 text-sm shadow-sm sm:grid-cols-3">
            <div><p className="text-xs text-ink-faint">Propositions ouvertes</p><p className="text-18 font-title tabular-nums">{q.data.totals.count}</p></div>
            <div><p className="text-xs text-ink-faint">Montant sur la durée (HT)</p><p className="text-18 font-title tabular-nums">{formatCents(q.data.totals.amountCents)}</p></div>
            <div><p className="text-xs text-ink-faint">Montant pondéré par la probabilité</p><p className="text-18 font-title tabular-nums">{formatCents(q.data.totals.weightedCents)}</p></div>
          </section>
          {view === 'board' ? <Board data={q.data} /> : <PipelineList data={q.data} />}
        </>
      )}
    </Frame>
  );
}

function Board({ data }: { data: Pipeline }) {
  return (
    <section aria-label="Pipeline en colonnes" className="flex gap-3 overflow-x-auto pb-2">
      {data.columns.map((col) => {
        const label = `${proposalStatusLabel(col.status)} — ${plural(col.count, 'proposition', 'propositions')}, ${formatCents(col.amountCents)}, pondéré ${formatCents(col.weightedCents)}`;
        const cards = data.items.filter((i) => i.status === col.status);
        return (
          <div key={col.status} className="flex w-[260px] shrink-0 flex-col gap-2 rounded-lg border border-line bg-slate-50 p-3">
            <div className="flex flex-col gap-0.5" aria-hidden="true">
              <div className="flex items-center justify-between gap-2">
                <ProposalStatusBadge status={col.status} />
                <span className="text-13 font-button tabular-nums">{col.count}</span>
              </div>
              <span className="text-xs tabular-nums text-ink-muted">{formatCents(col.amountCents)} · pondéré {formatCents(col.weightedCents)}</span>
            </div>
            <ul aria-label={label} className="flex flex-col gap-2">
              {cards.map((i) => (
                <li key={i.id} className="flex flex-col gap-1 rounded border border-line bg-surface p-2.5 text-13 shadow-sm">
                  <Link to={`/proposals/${i.id}`} className="font-button text-primary hover:underline">{i.number} · {i.title}</Link>
                  <span>{i.customer.name}</span>
                  <span className="tabular-nums">{formatCents(i.amountCents)} <span className="text-ink-faint">· pondéré {formatCents(i.weightedCents)}</span></span>
                  <span className="text-ink-muted">Probabilité {i.probability} % · {i.owner.name ?? '—'}</span>
                  <span className="text-ink-faint">{i.expiresAt ? `Échéance ${formatDay(i.expiresAt)}` : 'Non envoyée'}</span>
                </li>
              ))}
            </ul>
            {cards.length === 0 && <p className="text-xs text-ink-faint">Aucune proposition.</p>}
          </div>
        );
      })}
    </section>
  );
}

function PipelineList({ data }: { data: Pipeline }) {
  return (
    <Card>
      <Table
        caption="Pipeline des propositions"
        head={<tr><th scope="col">Numéro</th><th scope="col">Client</th><th scope="col">Statut</th><th scope="col">Montant HT</th><th scope="col">Probabilité</th><th scope="col">Pondéré</th><th scope="col">Commercial</th><th scope="col">Modèle</th><th scope="col">Échéance</th></tr>}
      >
        {data.items.map((i) => (
          <tr key={i.id}>
            <td><Link to={`/proposals/${i.id}`} className="font-button text-primary hover:underline">{i.number}</Link></td>
            <td>{i.customer.name}</td>
            <td><ProposalStatusBadge status={i.status} /></td>
            <td className="tabular-nums">{formatCents(i.amountCents)}</td>
            <td className="tabular-nums">{i.probability} %</td>
            <td className="tabular-nums">{formatCents(i.weightedCents)}</td>
            <td>{i.owner.name ?? '—'}</td>
            <td>{i.template?.name ?? 'Sans modèle'}</td>
            <td>{formatDay(i.expiresAt)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

export function ProposalDashboardPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '' });
  const q = useQuery({ queryKey: ['proposal-dashboard', applied], queryFn: () => apiGet<Dashboard>(`${R}/dashboard${query(applied)}`) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ from, to });
  };
  const d = q.data;
  return (
    <Frame title="Tableau de bord commercial">
      <Card>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-[5px]">
            <label htmlFor="tb-du" className="text-xs+ font-button text-ink-muted">Du</label>
            <Input id="tb-du" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="flex flex-col gap-[5px]">
            <label htmlFor="tb-au" className="text-xs+ font-button text-ink-muted">Au</label>
            <Input id="tb-au" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button type="submit" variant="secondary">Appliquer</Button>
          <span className="flex-1" />
          <a className={buttonClass('secondary')} href={`${R}/dashboard.csv${query(applied)}`}>Exporter en CSV</a>
        </form>
        <p className="mt-2 text-xs text-ink-faint">Période sur la date d’envoi ; par défaut, les 12 derniers mois.</p>
      </Card>

      {q.isLoading ? <Spinner /> : q.error || !d ? <ErrorNote>{errorMessage(q.error, 'Indicateurs indisponibles.')}</ErrorNote> : (
        <>
          <section aria-label="Indicateurs clés" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
            <p className="text-13 text-ink-muted">Période : du {formatDay(`${d.period.from}T12:00:00Z`)} au {formatDay(`${d.period.to}T12:00:00Z`)}</p>
            <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {([
                ['Envoyées', String(d.sent)], ['Signées', String(d.won)], ['Perdues', String(d.lost)], ['En cours', String(d.open)],
                ['Taux de conversion', pct(d.conversionRatePercent)], ['Taux sur les décidées', pct(d.decidedConversionRatePercent)],
                ['Délai moyen envoi → signature', d.averageDaysSentToSigned === null ? '—' : `${String(d.averageDaysSentToSigned).replace('.', ',')} jours`],
                ['Récurrent mensuel signé (HT)', formatCents(d.signedRecurringMonthlyCents)], ['Frais uniques signés (HT)', formatCents(d.signedOneTimeCents)],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <dt className="text-xs text-ink-faint">{k}</dt>
                  <dd className="text-18 font-title tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <ConversionTable caption="Conversion par modèle" first="Modèle" rows={d.byTemplate} />
            <ConversionTable caption="Conversion par commercial" first="Commercial" rows={d.byOwner} />
            <Card title="Sections les plus lues">
              {d.mostReadSections.length === 0 ? <p className="text-13 text-ink-muted">Aucune lecture enregistrée.</p> : (
                <Table caption="Sections les plus lues" head={<tr><th scope="col">Section</th><th scope="col">Ouvertures</th><th scope="col">Durée moyenne</th></tr>}>
                  {d.mostReadSections.map((s) => (
                    <tr key={s.sectionKey}><td><code className="text-xs">{s.sectionKey}</code></td><td className="tabular-nums">{s.opens}</td><td className="tabular-nums">{formatDuration(s.averageSeconds * 1000)}</td></tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="Motifs de refus">
              {d.declineReasons.length === 0 ? <p className="text-13 text-ink-muted">Aucun refus sur la période.</p> : (
                <Table caption="Motifs de refus" head={<tr><th scope="col">Motif</th><th scope="col">Nombre</th></tr>}>
                  {d.declineReasons.map((r) => (
                    <tr key={r.code}><td>{r.code === 'NON_PRECISE' ? 'Non précisé' : (DECLINE_REASON_LABELS[r.code] ?? r.code)}</td><td className="tabular-nums">{r.count}</td></tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="Options les plus retenues">
              {d.mostChosenOptions.length === 0 ? <p className="text-13 text-ink-muted">Aucune configuration figée sur la période.</p> : (
                <Table caption="Options les plus retenues" head={<tr><th scope="col">Option</th><th scope="col">Configurations acceptées</th></tr>}>
                  {d.mostChosenOptions.map((o) => <tr key={o.code}><td><code className="text-xs">{o.code}</code></td><td className="tabular-nums">{o.count}</td></tr>)}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </Frame>
  );
}

function ConversionTable({ caption, first, rows }: { caption: string; first: string; rows: ConversionRow[] }) {
  return (
    <Card title={caption}>
      {rows.length === 0 ? <p className="text-13 text-ink-muted">Aucune proposition envoyée sur la période.</p> : (
        <Table caption={caption} head={<tr><th scope="col">{first}</th><th scope="col">Envoyées</th><th scope="col">Signées</th><th scope="col">Conversion</th><th scope="col">Récurrent signé</th></tr>}>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td><td className="tabular-nums">{r.sent}</td><td className="tabular-nums">{r.won}</td>
              <td className="tabular-nums">{pct(r.conversionRatePercent)}</td><td className="tabular-nums">{formatCents(r.wonMonthlyCents)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
