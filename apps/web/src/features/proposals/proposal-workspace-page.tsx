import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Button, buttonClass } from '../../ui/button.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Tabs } from '../../ui/tabs.js';
import { useToast } from '../../ui/toast.js';
import { CommentsPanel } from './comments-panel.js';
import { PreviewDialog } from './preview-dialog.js';
import { PricingPanel } from './pricing-panel.js';
import { ProposalActions } from './proposal-actions.js';
import { proposalsApi, type ProposalDetail } from './proposal-api.js';
import { ACCEPTANCE_MODE_LABELS, COMMERCIAL_STATUS_LABELS, formatDay, ProposalStatusBadge } from './proposal-labels.js';
import { RecipientsPanel } from './recipients-panel.js';
import { SectionsEditor } from './sections-editor.js';
import { SettingsPanel } from './settings-panel.js';
import { SignaturePanel } from './signature-panel.js';
import { TrackingPanel } from './tracking-panel.js';
import { useProposalStream } from './use-proposal-stream.js';

/**
 * Espace de travail d'une proposition (brief §12.2-12.7) : en-tête (statut,
 * transitions permises), rédaction par blocs, tableau de prix, destinataires
 * et envoi, suivi de lecture, échanges, signature et conversion.
 */
export function ProposalWorkspacePage() {
  const { id = '' } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('contenu');
  const [preview, setPreview] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const key = ['proposal', id];
  const q = useQuery({ queryKey: key, queryFn: () => proposalsApi.get(id) });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['proposal', id] });
    void qc.invalidateQueries({ queryKey: ['proposal-tracking', id] });
    void qc.invalidateQueries({ queryKey: ['proposal-comments', id] });
  };
  const setDetail = (d: ProposalDetail) => {
    qc.setQueryData(key, d);
    void qc.invalidateQueries({ queryKey: ['proposal-tracking', id] });
  };
  const live = useProposalStream((m) => {
    if (m.proposalId !== id) return;
    refresh();
    setLastEvent(m.subject);
    toast.show(m.subject, 'info');
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote>{errorMessage(q.error, 'Proposition indisponible.')}</ErrorNote>;

  const d = q.data;
  const p = d.proposal;
  const draft = p.status === 'DRAFT' && !d.version.lockedAt;
  const canWrite = allows(me.data, 'proposals.write');
  const toValidate = d.readiness.issues.some((i) => i.code === 'TO_VALIDATE');
  const showIssues = ['DRAFT', 'IN_INTERNAL_REVIEW', 'READY'].includes(p.status) && d.readiness.issues.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Propositions', to: '/proposals' }, { label: p.number }]} />

      <section aria-label={`Proposition ${p.number}`} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-22">{p.number} · {p.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-13 text-ink-muted">
              <ProposalStatusBadge status={p.status} />
              {p.reviewRequired && <Badge tone="warn">Revue interne requise</Badge>}
              <span>Client : <Link to={`/customers/${p.customer.id}`} className="text-primary hover:underline">{p.customer.name}</Link></span>
              {p.customer.commercialStatus && <Badge tone="muted">{COMMERCIAL_STATUS_LABELS[p.customer.commercialStatus] ?? p.customer.commercialStatus}</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPreview(true)}>Aperçu</Button>
            <a className={buttonClass('secondary', 'sm')} href={proposalsApi.pdfUrl(p.id)} target="_blank" rel="noopener">Télécharger le PDF</a>
          </div>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-13 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="inline text-ink-faint">Version : </dt><dd className="inline">Version {d.version.number}{d.version.lockedAt ? ` (figée le ${formatDay(d.version.lockedAt)})` : ' (brouillon modifiable)'}</dd></div>
          <div>
            <dt className="inline text-ink-faint">Conditions : </dt>
            <dd className="inline">{d.version.terms ? `CGV v${d.version.terms.versionNumber} — ${d.version.terms.title}` : <span className="text-danger">aucune CGV publiée</span>}</dd>
          </div>
          <div><dt className="inline text-ink-faint">Acceptation : </dt><dd className="inline">{ACCEPTANCE_MODE_LABELS[p.acceptanceMode] ?? p.acceptanceMode}</dd></div>
          <div><dt className="inline text-ink-faint">Échéance : </dt><dd className="inline">{p.expiresAt ? formatDay(p.expiresAt) : p.fixedExpiryDate ? `${formatDay(p.fixedExpiryDate)} (date fixe)` : `${p.validityDays} jours après l’envoi`}</dd></div>
          <div><dt className="inline text-ink-faint">Commercial : </dt><dd className="inline">{p.owner?.fullName ?? '—'}</dd></div>
          <div><dt className="inline text-ink-faint">Temps réel : </dt><dd className="inline">{live === 'open' ? 'connecté' : live === 'connecting' ? 'connexion…' : 'indisponible (rechargement à chaque action)'}</dd></div>
        </dl>
        {lastEvent && <p role="status" className="text-13 text-info">{lastEvent}</p>}
        <ProposalActions detail={d} me={me.data} onDetail={setDetail} onRefresh={refresh} />
      </section>

      {d.readiness.reviewReasons.length > 0 && (
        <section aria-label="Motifs de revue interne" className="rounded-lg border border-warn bg-warn-bg px-4 py-3 text-13 text-warn">
          <p className="font-button">Revue interne obligatoire :</p>
          <ul className="list-disc pl-5">{d.readiness.reviewReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </section>
      )}
      {showIssues && (
        <section aria-label="Points bloquants avant envoi" className="rounded-lg border border-line bg-surface px-4 py-3 text-13 shadow-sm">
          <p className="font-button text-ink">Points bloquants avant envoi ({d.readiness.issues.length})</p>
          <ul className="list-disc pl-5 text-ink-muted">{d.readiness.issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}</ul>
          {toValidate && (
            <p className="mt-1 text-ink-muted">
              Les éléments « à valider » se valident par un administrateur : <Link to="/proposal-admin/pending" className="text-primary hover:underline">Prix à valider</Link>.
            </p>
          )}
        </section>
      )}

      <Tabs
        label="Rubriques de la proposition"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'contenu', label: 'Contenu' },
          { id: 'prix', label: 'Tarification' },
          { id: 'destinataires', label: 'Destinataires et envoi', badge: d.recipients.length },
          { id: 'suivi', label: 'Suivi' },
          { id: 'echanges', label: 'Échanges' },
          { id: 'signature', label: 'Signature et contrat' },
          { id: 'reglages', label: 'Réglages' },
        ]}
        panels={{
          contenu: <SectionsEditor detail={d} me={me.data} editable={draft && canWrite} onDetail={setDetail} />,
          prix: <PricingPanel detail={d} me={me.data} onDetail={setDetail} />,
          destinataires: <RecipientsPanel detail={d} me={me.data} onDetail={setDetail} />,
          suivi: <TrackingPanel detail={d} />,
          echanges: <CommentsPanel detail={d} me={me.data} />,
          signature: <SignaturePanel detail={d} me={me.data} onRefresh={refresh} />,
          reglages: <SettingsPanel detail={d} me={me.data} onDetail={setDetail} />,
        }}
      />

      {preview && <PreviewDialog proposalId={p.id} number={p.number} onClose={() => setPreview(false)} />}
    </div>
  );
}
