import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { Spinner } from '../../ui/spinner.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { StatusBadge } from '../../ui/badge.js';
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

const ARCHIVABLE_STATUSES = ['TERMINATED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'RENEWED'];

interface Detail {
  contract: {
    id: string;
    reference: string;
    title: string;
    status: string;
    currentVersionId: string | null;
    startDate: string | null;
    endDate: string | null;
    noticePeriodDays: number | null;
    archivedAt: string | null;
    origin: 'NATIVE' | 'IMPORTED';
  };
  customer: { name: string };
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

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  const allowed = useQuery({
    queryKey: ['allowed-actions', id],
    queryFn: () => apiGet<{ allowedActions: string[] }>(`/v1/contracts/${id}/allowed-actions`),
  });
  const me = useMe();
  const qc = useQueryClient();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Contrat introuvable.</p>;
  const { contract, customer } = q.data;
  const canDownloadSigned = q.data.signatureRequest?.status === 'COMPLETED';
  const canArchive = me.data?.roles?.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r)) ?? false;
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{contract.reference} — {contract.title}</h1>
          <p className="text-gray-500">
            {customer.name} · <StatusBadge status={contract.status} />
            {contract.origin === 'IMPORTED' && (
              <span className="ml-2 rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">Importé</span>
            )}
          </p>
          <p className="text-sm text-gray-400">
            {contract.startDate ? new Date(contract.startDate).toLocaleDateString('fr-FR') : '—'}
            {' → '}
            {contract.endDate ? new Date(contract.endDate).toLocaleDateString('fr-FR') : '—'}
          </p>
          {contract.archivedAt ? (
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span>Archivé le {new Date(contract.archivedAt).toLocaleDateString('fr-FR')}</span>
              {canArchive && <button type="button" className="text-lsi underline" onClick={() => archiveAct('unarchive')}>Désarchiver</button>}
            </div>
          ) : (
            canArchive && ARCHIVABLE_STATUSES.includes(contract.status) && (
              <button type="button" className="text-lsi underline text-sm" onClick={() => archiveAct('archive')}>Archiver</button>
            )
          )}
        </div>
        {canDownloadSigned && (
          <div className="flex flex-col items-end gap-1">
            <Button onClick={handleDownload}>Télécharger le signé</Button>
            {downloadError && <p className="text-sm text-red-600">{downloadError}</p>}
          </div>
        )}
      </div>
      <WorkflowActions
        contractId={contract.id}
        status={contract.status}
        allowedActions={allowed.data?.allowedActions ?? []}
        roles={me.data?.roles ?? []}
        currentUserId={me.data?.userId ?? ''}
        approval={q.data.approval}
      />
      <SendForSignature
        contractId={contract.id}
        signers={q.data.signers}
        allowedActions={allowed.data?.allowedActions ?? []}
        roles={me.data?.roles ?? []}
      />
      <Card title="Contenu">
        <div className="flex flex-wrap gap-3 text-sm">
          {['DRAFT', 'CHANGES_REQUESTED'].includes(contract.status) && (
            <Link to={`/contracts/${contract.id}/edit`} className="text-lsi hover:underline">Éditer le contenu</Link>
          )}
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/preview.pdf`} target="_blank" rel="noopener" className="text-lsi hover:underline">Aperçu PDF</a>
          )}
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/export.pdf`} className="text-lsi hover:underline">Télécharger PDF</a>
          )}
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/export.docx`} className="text-lsi hover:underline">Télécharger DOCX</a>
          )}
          <Link to={`/contracts/${contract.id}/versions`} className="text-lsi hover:underline">Historique</Link>
          {!contract.currentVersionId && contract.origin !== 'IMPORTED' && (
            <span className="text-gray-400">Aucun contenu rédigé.</span>
          )}
        </div>
        {contract.origin === 'IMPORTED' && (
          <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
            <p className="font-medium text-gray-700">Document importé (signé hors application)</p>
            {q.data.importedDocument ? (
              <a
                href={`/v1/contracts/${contract.id}/imported-document`}
                className="text-lsi hover:underline"
              >
                Télécharger le document
              </a>
            ) : (
              <span className="text-gray-400">Document indisponible.</span>
            )}
          </div>
        )}
      </Card>
      <SignersBlock
        contractId={contract.id}
        signers={q.data.signers}
        editable={['DRAFT', 'CHANGES_REQUESTED'].includes(contract.status)}
      />
      <SignatureActions contractId={contract.id} status={contract.status} roles={me.data?.roles ?? []} />
      <TerminateContract
        contractId={contract.id}
        customerName={customer.name}
        noticePeriodDays={contract.noticePeriodDays}
        roles={me.data?.roles ?? []}
        allowedActions={allowed.data?.allowedActions ?? []}
      />
      <RenewContract
        contractId={contract.id}
        status={contract.status}
        roles={me.data?.roles ?? []}
        renewal={q.data.renewal}
        predecessor={q.data.predecessor}
      />
      <AmendContract
        contractId={contract.id}
        status={contract.status}
        roles={me.data?.roles ?? []}
        openAmendment={q.data.openAmendment}
        amends={q.data.amends}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SignatureBlock data={q.data.signatureRequest} />
        <RemindersBlock reminders={q.data.reminders} />
      </div>
      <Timeline events={q.data.timeline} />
      <CommentsBlock contractId={contract.id} />
    </div>
  );
}
