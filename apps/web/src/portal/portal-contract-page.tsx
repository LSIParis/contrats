import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { portalGet, portalPost, PortalUnauthorized } from './portal-api.js';
import { Spinner } from '../ui/spinner.js';
import { Card } from '../ui/card.js';
import { StatusBadge } from '../ui/badge.js';
import { contractCategoryLabel, partyLabel, signerStatusLabel, commentAuthorLabel } from '../lib/labels.js';

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

interface PortalComment {
  id: string;
  body: string | null;
  author: { fullName: string; kind: string };
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

const RENEW_PREFILL = 'Bonjour, je souhaite renouveler ce contrat. Merci de me recontacter.';
const TERMINATE_PREFILL = 'Bonjour, je souhaite résilier ce contrat. Merci de me recontacter.';

function CommentsCard({ contractId }: { contractId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const comments = useQuery({
    queryKey: ['portal-comments', contractId],
    queryFn: () => portalGet<{ items: PortalComment[] }>(`/v1/portal/contracts/${contractId}/comments`),
    retry: false,
  });
  const send = useMutation({
    mutationFn: (body: string) => portalPost(`/v1/portal/contracts/${contractId}/comments`, { body }),
    onSuccess: () => { setDraft(''); qc.invalidateQueries({ queryKey: ['portal-comments', contractId] }); },
  });
  const items = comments.data?.items ?? [];
  return (
    <Card title="Échanges avec LSI">
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun message pour le moment.</p>
      ) : (
        <ul className="mb-4 space-y-3">
          {items.map((m) => (
            <li key={m.id} className="text-sm">
              <div className="font-medium">{commentAuthorLabel(m.author.kind)} <span className="text-gray-400">· {new Date(m.createdAt).toLocaleDateString('fr-FR')}</span></div>
              <div className="whitespace-pre-wrap text-gray-700">
                {m.deletedAt ? (
                  <span className="italic text-gray-400">message supprimé</span>
                ) : (
                  <>
                    {m.body}
                    {m.editedAt && <span className="text-xs text-gray-400"> (modifié)</span>}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => setDraft(RENEW_PREFILL)} className="rounded border border-lsi px-3 py-1 text-xs text-lsi hover:bg-lsi/10">Demander un renouvellement</button>
        <button type="button" onClick={() => setDraft(TERMINATE_PREFILL)} className="rounded border border-lsi px-3 py-1 text-xs text-lsi hover:bg-lsi/10">Demander une résiliation</button>
      </div>
      <textarea
        value={draft} onChange={(e) => setDraft(e.target.value)}
        rows={3} placeholder="Écrire un message à LSI…"
        className="w-full rounded border border-gray-300 p-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button" disabled={!draft.trim() || send.isPending}
          onClick={() => send.mutate(draft.trim())}
          className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark disabled:opacity-50"
        >Envoyer</button>
        {send.isError && <span className="text-sm text-red-600">Envoi impossible.</span>}
      </div>
    </Card>
  );
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
      <CommentsCard contractId={id!} />
    </div>
  );
}
