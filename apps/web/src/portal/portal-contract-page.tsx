import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { portalGet, PortalUnauthorized } from './portal-api.js';
import { Spinner } from '../ui/spinner.js';
import { Card } from '../ui/card.js';
import { StatusBadge } from '../ui/badge.js';
import { contractCategoryLabel, partyLabel, signerStatusLabel } from '../lib/labels.js';

interface PortalSigner {
  party: string;
  fullName: string;
  status: string;
  signedAt: string | null;
}

interface PortalContractDetail {
  id: string;
  reference: string;
  title: string;
  status: string;
  category: string;
  startDate: string | null;
  endDate: string | null;
  amountCents: number | null;
  currency: string | null;
  billingFrequency: string | null;
  signers: PortalSigner[];
  mySignature: { status: string } | null;
}

const PENDING_SIGNER_STATUSES = ['SENT', 'VIEWED'];

function formatAmount(amountCents: number | null, currency: string | null): string {
  if (amountCents === null || !currency) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amountCents / 100);
}

function formatDate(date: string | null): string {
  return date ? new Date(date).toLocaleDateString('fr-FR') : '—';
}

export function PortalContractPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['portal-contract', id],
    queryFn: () => portalGet<PortalContractDetail>(`/v1/portal/contracts/${id}`),
    retry: false,
  });

  useEffect(() => {
    if (query.error instanceof PortalUnauthorized) navigate('/portal/login', { replace: true });
  }, [query.error, navigate]);

  if (query.isLoading) return <Spinner />;
  if (query.error || !query.data) return <p className="text-red-600">Contrat introuvable.</p>;
  const c = query.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{c.reference} — {c.title}</h1>
        <p className="text-gray-500">
          {contractCategoryLabel(c.category)} · <StatusBadge status={c.status} />
        </p>
        <p className="text-sm text-gray-400">
          {formatDate(c.startDate)} {' → '} {formatDate(c.endDate)}
        </p>
        <p className="text-sm text-gray-400">{formatAmount(c.amountCents, c.currency)}</p>
      </div>
      <Card title="Signataires">
        {c.mySignature && PENDING_SIGNER_STATUSES.includes(c.mySignature.status) && (
          <a
            href={`/v1/portal/contracts/${id}/sign`}
            className="mb-3 inline-block rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark"
          >
            Signer le document
          </a>
        )}
        {c.signers.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun signataire.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {c.signers.map((s, i) => (
              <li key={`${s.party}-${s.fullName}-${i}`} className="flex items-center justify-between">
                <span>
                  {s.fullName} <span className="text-gray-400">({partyLabel(s.party)})</span>
                </span>
                <span className="text-gray-500">
                  {signerStatusLabel(s.status)} {s.signedAt ? `— ${formatDate(s.signedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
