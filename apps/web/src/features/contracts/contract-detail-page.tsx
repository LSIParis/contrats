import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { StatusBadge } from '../../ui/badge.js';
import { SignatureBlock, type SignatureData } from './signature-block.js';
import { RemindersBlock, type Reminder } from './reminders-block.js';
import { Timeline, type Event } from './timeline.js';

interface Detail {
  contract: {
    id: string;
    reference: string;
    title: string;
    status: string;
    currentVersionId: string | null;
    startDate: string | null;
    endDate: string | null;
  };
  customer: { name: string };
  signatureRequest: SignatureData | null;
  reminders: Reminder[];
  timeline: Event[];
}

async function downloadSigned(id: string) {
  const { url } = await apiGet<{ url: string }>(`/v1/contracts/${id}/signed-document`);
  window.open(url, '_blank', 'noopener');
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => apiGet<Detail>(`/v1/contracts/${id}`) });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Contrat introuvable.</p>;
  const { contract, customer } = q.data;
  const canDownloadSigned = q.data.signatureRequest?.status === 'COMPLETED';

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
          <p className="text-gray-500">{customer.name} · <StatusBadge status={contract.status} /></p>
          <p className="text-sm text-gray-400">
            {contract.startDate ? new Date(contract.startDate).toLocaleDateString('fr-FR') : '—'}
            {' → '}
            {contract.endDate ? new Date(contract.endDate).toLocaleDateString('fr-FR') : '—'}
          </p>
        </div>
        {canDownloadSigned && (
          <div className="flex flex-col items-end gap-1">
            <Button onClick={handleDownload}>Télécharger le signé</Button>
            {downloadError && <p className="text-sm text-red-600">{downloadError}</p>}
          </div>
        )}
      </div>
      <Card title="Contenu">
        <div className="flex flex-wrap gap-3 text-sm">
          {['DRAFT', 'CHANGES_REQUESTED'].includes(contract.status) && (
            <Link to={`/contracts/${contract.id}/edit`} className="text-lsi hover:underline">Éditer le contenu</Link>
          )}
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/preview.pdf`} target="_blank" rel="noopener" className="text-lsi hover:underline">Aperçu PDF</a>
          )}
          <Link to={`/contracts/${contract.id}/versions`} className="text-lsi hover:underline">Historique</Link>
          {!contract.currentVersionId && <span className="text-gray-400">Aucun contenu rédigé.</span>}
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SignatureBlock data={q.data.signatureRequest} />
        <RemindersBlock reminders={q.data.reminders} />
      </div>
      <Timeline events={q.data.timeline} />
    </div>
  );
}
