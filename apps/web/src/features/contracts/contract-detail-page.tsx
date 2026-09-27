import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { billingFrequencyLabel, contractCategoryLabel, renewalModeLabel } from '../../lib/labels.js';
import { formatEuros } from '../../lib/money.js';
import { Spinner } from '../../ui/spinner.js';
import { Button, buttonClass } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { ImportedBadge } from './imported-badge.js';
import { StatusBadge } from '../../ui/status-badge.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Icon } from '../../ui/icons.js';
import { Tabs, type TabDef } from '../../ui/tabs.js';
import { SignatureBlock, type SignatureData } from './signature-block.js';
import { RemindersBlock, type Reminder } from './reminders-block.js';
import { SignersBlock, type Signer } from './signers-block.js';
import { Timeline, type Event } from './timeline.js';
import { CommentsBlock } from './comments-block.js';
import { WorkflowActions } from './workflow-actions.js';
import { SendForSignature } from './send-for-signature.js';
import { SignatureActions } from './signature-actions.js';
import { TerminateContract } from './terminate-contract.js';
import { RenewContract } from './renew-contract.js';
import { AmendContract } from './amend-contract.js';
import { ContractDeadlines } from '../deadlines/deadlines.js';
import { ContractContentPanel } from '../structure/contract-content-panel.js';
import { AnnexesPanel } from '../structure/annexes-panel.js';
import { AiReviewBanner } from '../structure/ai-review.js';
import { allows } from '../../lib/permissions.js';
import { NegotiationActions } from '../negotiation/negotiation-actions.js';
import { AcceptancesBlock } from '../negotiation/acceptances-block.js';

const ARCHIVABLE_STATUSES = ['TERMINATED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'RENEWED'];

/** Onglets de la fiche contrat, dans l'ordre du brief (§11). */
export const CONTRACT_TABS: TabDef[] = [
  { id: 'synthese', label: 'Synthèse' },
  { id: 'contenu', label: 'Contenu' },
  { id: 'annexes', label: 'Annexes' },
  { id: 'tarification', label: 'Tarification' },
  { id: 'signature', label: 'Signature' },
  { id: 'avenants', label: 'Avenants' },
  { id: 'echeances', label: 'Échéances' },
  { id: 'documents', label: 'Documents' },
  { id: 'historique', label: 'Historique' },
];

interface Detail {
  contract: {
    id: string;
    reference: string;
    title: string;
    status: string;
    currentVersionId: string | null;
    startDate: string | null;
    endDate: string | null;
    signedAt?: string | null;
    noticePeriodDays: number | null;
    noticePeriodMonths?: number | null;
    renewalMode?: string | null;
    renewalPeriodMonths?: number | null;
    amountCents?: number | string | null;
    billingFrequency?: string | null;
    category?: string | null;
    archivedAt: string | null;
    origin: 'NATIVE' | 'IMPORTED' | 'AI';
    unreviewedAiClauses?: number;
    missingVariables?: number;
    terminationEffectiveDate?: string | null;
    acceptedVersionId?: string | null;
    approvedVersionId?: string | null;
  };
  customer: { id?: string; name: string };
  importedDocument: { name: string } | null;
  signatureRequest: SignatureData | null;
  reminders: Reminder[];
  timeline: Event[];
  signers: Signer[];
  approval: { submittedByUserId: string; decision: string; reason: string | null; decidedByUserId: string | null } | null;
  renewal: { status: string; newContractId: string | null; refusalReason: string | null; successor: { reference: string; status: string } } | null;
  predecessor: { id: string; reference: string } | null;
  openAmendment: { id: string; reference: string; status: string } | null;
  amends: { id: string; reference: string } | null;
}

async function downloadSigned(id: string) {
  const { url } = await apiGet<{ url: string }>(`/v1/contracts/${id}/signed-document`);
  window.open(url, '_blank', 'noopener');
}

const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '—');

function Placeholder({ title, lot, children }: { title: string; lot: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        <Icon name="info" />
        <span><strong>Disponible au {lot}.</strong> {children}</span>
      </p>
    </Card>
  );
}

function Dl({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  const allowed = useQuery({
    queryKey: ['allowed-actions', id],
    queryFn: () => apiGet<{ allowedActions: string[] }>(`/v1/contracts/${id}/allowed-actions`),
  });
  const me = useMe();
  const qc = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const requested = params.get('onglet');
  const tab = CONTRACT_TABS.some((t) => t.id === requested) ? requested! : 'synthese';
  const setTab = (t: string) => setParams((p) => { p.set('onglet', t); return p; }, { replace: true });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p role="alert" className="text-danger">Contrat introuvable.</p>;
  const d = q.data;
  const { contract, customer } = d;
  const roles = me.data?.roles ?? [];
  const allowedActions = allowed.data?.allowedActions ?? [];
  const imported = contract.origin === 'IMPORTED';
  const pendingImport = contract.status === 'IMPORTED_PENDING_VALIDATION';
  const canDownloadSigned = d.signatureRequest?.status === 'COMPLETED';
  const canArchive = roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));
  const archiveAct = (verb: 'archive' | 'unarchive') =>
    apiPost(`/v1/contracts/${contract.id}/${verb}`, {}).then(() => qc.invalidateQueries({ queryKey: ['contract', id] }));

  async function handleDownload() {
    if (!id) return;
    setDownloadError(null);
    try {
      await downloadSigned(id);
    } catch {
      setDownloadError('Document signé indisponible.');
    }
  }

  const notice = contract.noticePeriodMonths != null
    ? `${contract.noticePeriodMonths} mois`
    : contract.noticePeriodDays != null ? `${contract.noticePeriodDays} jours` : '—';
  const amount = contract.amountCents != null && Number.isFinite(Number(contract.amountCents))
    ? `${formatEuros(Number(contract.amountCents))} HT${contract.billingFrequency ? ` · ${billingFrequencyLabel(contract.billingFrequency).toLowerCase()}` : ''}`
    : '—';

  const synthese = (
    <div className="flex flex-col gap-4">
      <Card title="Synthèse">
        <Dl rows={[
          ['Client', customer.id ? <Link to={`/customers/${customer.id}`} className="text-primary hover:underline">{customer.name}</Link> : customer.name],
          ['Statut', <StatusBadge key="s" status={contract.status} />],
          ['Origine', imported ? 'Import d’un contrat existant (signé hors plateforme)' : 'Rédigé dans l’application'],
          ['Catégorie', contract.category ? contractCategoryLabel(contract.category) : '—'],
          ['Signé le', fmtDate(contract.signedAt)],
          ['Période', `${fmtDate(contract.startDate)} → ${fmtDate(contract.endDate)}`],
          ['Préavis', notice],
          ['Reconduction', contract.renewalMode
            ? `${renewalModeLabel(contract.renewalMode)}${contract.renewalPeriodMonths ? ` (${contract.renewalPeriodMonths} mois)` : ''}`
            : '—'],
          ['Montant', amount],
        ]} />
      </Card>
      <WorkflowActions
        contractId={contract.id}
        status={contract.status}
        allowedActions={allowedActions}
        roles={roles}
        currentUserId={me.data?.userId ?? ''}
        approval={d.approval}
      />
      <NegotiationActions
        contractId={contract.id}
        currentVersionId={contract.currentVersionId}
        allowedActions={allowedActions}
        me={me.data}
      />
      <TerminateContract
        contractId={contract.id}
        customerName={customer.name}
        noticePeriodDays={contract.noticePeriodDays}
        roles={roles}
        allowedActions={allowedActions}
      />
      <RenewContract
        contractId={contract.id}
        status={contract.status}
        roles={roles}
        renewal={d.renewal}
        predecessor={d.predecessor}
      />
      {!imported && <AcceptancesBlock contractId={contract.id} currentVersionId={contract.currentVersionId} />}
    </div>
  );

  const contenu = (
    <ContractContentPanel
      contractId={contract.id}
      currentVersionId={contract.currentVersionId}
      imported={imported}
      allowedActions={allowedActions}
      me={me.data}
    />
  );

  const signature = (
    <div className="flex flex-col gap-4">
      {imported && (
        <p className="flex items-center gap-2 rounded border border-info bg-info-bg px-3 py-2 text-sm text-info">
          <Icon name="fileCheck" />
          Contrat signé hors plateforme — aucune nouvelle signature ne sera demandée.
        </p>
      )}
      {canDownloadSigned && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleDownload}>Télécharger le signé</Button>
          {downloadError && <p role="alert" className="text-sm text-danger">{downloadError}</p>}
        </div>
      )}
      <SendForSignature contractId={contract.id} signers={d.signers} allowedActions={allowedActions} roles={roles} />
      <SignersBlock
        contractId={contract.id}
        signers={d.signers}
        editable={['DRAFT', 'CHANGES_REQUESTED'].includes(contract.status)}
      />
      <SignatureActions contractId={contract.id} status={contract.status} roles={roles} />
      <SignatureBlock data={d.signatureRequest} />
    </div>
  );

  const avenants = (
    <Card title="Avenants">
      {!d.openAmendment && !d.amends && <p className="mb-2 text-sm text-ink-faint">Aucun avenant lié à ce contrat.</p>}
      <AmendContract
        contractId={contract.id}
        status={contract.status}
        roles={roles}
        openAmendment={d.openAmendment}
        amends={d.amends}
      />
    </Card>
  );

  const echeances = (
    <div className="flex flex-col gap-4">
      <ContractDeadlines contractId={contract.id} />
      <RemindersBlock reminders={d.reminders} />
    </div>
  );

  const documents = (
    <Card title="Documents">
      <ul className="flex flex-col gap-3 text-sm">
        {imported && (
          <li className="flex flex-col gap-1">
            <span className="font-medium text-ink">Document original importé (signé hors application)</span>
            {d.importedDocument ? (
              <span className="flex flex-wrap gap-3">
                <a href={`/v1/contracts/${contract.id}/imported-document`} className="text-primary hover:underline">
                  Télécharger « {d.importedDocument.name} »
                </a>
                <Link to={`/contracts/${contract.id}/import`} className="text-primary hover:underline">
                  Écran d’import (original, copie OCR, empreinte SHA-256)
                </Link>
              </span>
            ) : (
              <span className="text-ink-faint">Document indisponible.</span>
            )}
          </li>
        )}
        {canDownloadSigned && (
          <li className="flex flex-col gap-1">
            <span className="font-medium text-ink">Contrat signé électroniquement</span>
            <button type="button" className="self-start text-primary hover:underline" onClick={handleDownload}>
              Télécharger le signé
            </button>
          </li>
        )}
        {contract.currentVersionId && (
          <li className="flex flex-col gap-1">
            <span className="font-medium text-ink">Version courante du contenu</span>
            <a href={`/v1/contracts/${contract.id}/export.pdf`} className="text-primary hover:underline">Télécharger PDF</a>
          </li>
        )}
        {!imported && !canDownloadSigned && !contract.currentVersionId && (
          <li className="text-ink-faint">Aucun document.</li>
        )}
      </ul>
    </Card>
  );

  const historique = (
    <div className="flex flex-col gap-4">
      <Timeline events={d.timeline} />
      <CommentsBlock contractId={contract.id} />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Contrats', to: '/contracts' }, { label: contract.reference }]} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1>{contract.reference} — {contract.title}</h1>
          <p className="flex flex-wrap items-center gap-2 text-ink-muted">
            <span>{customer.name}</span>
            <StatusBadge status={contract.status} />
            {imported && <ImportedBadge />}
          </p>
          {contract.archivedAt ? (
            <div className="flex items-center gap-3 text-sm text-ink-muted">
              <span>Archivé le {fmtDate(contract.archivedAt)}</span>
              {canArchive && <button type="button" className="text-primary underline" onClick={() => archiveAct('unarchive')}>Désarchiver</button>}
            </div>
          ) : (
            canArchive && ARCHIVABLE_STATUSES.includes(contract.status) && (
              <button type="button" className="self-start text-sm text-primary underline" onClick={() => archiveAct('archive')}>Archiver</button>
            )
          )}
        </div>
      </div>
      <AiReviewBanner count={contract.unreviewedAiClauses ?? 0} />
      {(contract.missingVariables ?? 0) > 0 && (
        <p className="flex items-center gap-2 rounded-lg border border-warn bg-warn-bg px-4 py-3 text-sm text-warn">
          <Icon name="alert" />
          {contract.missingVariables} variable(s) du contrat restent à compléter (onglet Contenu) : la soumission en revue interne est bloquée.
        </p>
      )}
      {pendingImport && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warn bg-warn-bg px-4 py-3 text-sm text-warn">
          <Icon name="alert" />
          <span>Import en attente de validation : le contrat ne sera actif qu’après la revue des champs extraits.</span>
          <Link to={`/contracts/${contract.id}/import`} className={`${buttonClass('secondary', 'sm')} ml-auto`}>
            Valider l’import
          </Link>
        </div>
      )}
      <Tabs
        label="Sections du contrat"
        tabs={CONTRACT_TABS}
        active={tab}
        onChange={setTab}
        panels={{
          synthese,
          contenu,
          annexes: (
            <AnnexesPanel
              contractId={contract.id}
              editable={allowedActions.includes('EDIT_CONTENT') && allows(me.data, 'contracts.write')}
            />
          ),
          tarification: (
            <Placeholder title="Tarification" lot="lot 3">
              Le barème, les révisions et le simulateur tarifaire arriveront avec le moteur de tarification.
            </Placeholder>
          ),
          signature,
          avenants,
          echeances,
          documents,
          historique,
        }}
      />
    </div>
  );
}
