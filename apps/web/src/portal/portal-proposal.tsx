import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portalGet, portalPost, PortalError } from './portal-api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Icon } from '../ui/icons.js';
import { Spinner } from '../ui/spinner.js';

/** États où le client lit la version présentée (apps/api/src/portal/portal.service.ts). */
export const PROPOSAL_STATUSES = ['SENT_TO_CLIENT', 'IN_NEGOTIATION', 'ACCEPTED'];

interface Proposal {
  contractId: string;
  reference: string;
  title: string;
  status: string;
  version: { id: string; versionNumber: number; bodyHtml: string; createdAt: string } | null;
}

function acceptError(e: unknown): string {
  if (e instanceof PortalError && e.status === 403) return 'Seuls les signataires désignés par votre organisation peuvent accepter la proposition.';
  if (e instanceof PortalError && !/^Portail \d+$/.test(e.message)) return e.message;
  return 'Acceptation impossible. Réessayez ou contactez LSI.';
}

/**
 * Proposition présentée au client (portail) : texte de la VERSION présentée
 * et acceptation — distincte de la signature. L'identité (nom, e-mail) et
 * l'adresse IP sont relevées par le serveur depuis la session : rien n'est
 * déclaratif.
 */
export function PortalProposal({ contractId, status, identity }: {
  contractId: string;
  status: string;
  identity: { email?: string; customerName?: string | null } | undefined;
}) {
  const qc = useQueryClient();
  const [agreed, setAgreed] = useState(false);
  const q = useQuery({
    queryKey: ['portal-proposal', contractId],
    queryFn: () => portalGet<Proposal>(`/v1/portal/contracts/${contractId}/proposal`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: (versionId: string) => portalPost<{ status: string; acceptedAt: string }>(`/v1/portal/contracts/${contractId}/accept`, { versionId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portal-contract', contractId] });
      void qc.invalidateQueries({ queryKey: ['portal-proposal', contractId] });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data?.version) return <Card title="Proposition"><p className="text-sm text-danger">Proposition indisponible.</p></Card>;
  const v = q.data.version;
  const accepted = status === 'ACCEPTED' || accept.isSuccess;

  return (
    <Card title={`Proposition — version ${v.versionNumber} du ${new Date(v.createdAt).toLocaleDateString('fr-FR')}`}>
      <div className="flex flex-col gap-4">
        <article aria-label="Texte de la proposition" className="prose max-h-[560px] max-w-none overflow-y-auto rounded border border-line bg-page px-5 py-4 text-sm"
          dangerouslySetInnerHTML={{ __html: v.bodyHtml }} />
        {accepted ? (
          <p role="status" className="flex items-center gap-2 text-sm text-success">
            <Icon name="checkCircle" /> Vous avez accepté cette proposition. LSI-Maintenance va vous adresser le contrat à signer.
          </p>
        ) : status === 'IN_NEGOTIATION' ? (
          <p className="flex items-center gap-2 text-sm text-info">
            <Icon name="message" /> Proposition en cours de négociation : une nouvelle version vous sera présentée.
          </p>
        ) : (
          <form className="flex flex-col gap-3 rounded border border-line px-4 py-3 text-sm"
            onSubmit={(e) => { e.preventDefault(); if (agreed) accept.mutate(v.id); }}>
            <p className="text-ink-muted">
              Acceptation au nom de <strong>{identity?.email ?? 'votre compte'}</strong>
              {identity?.customerName ? <> pour <strong>{identity.customerName}</strong></> : null}.
              Elle est horodatée avec votre adresse IP et porte sur la version {v.versionNumber} ci-dessus. Elle ne vaut pas signature.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
              <span>J’ai lu la proposition (version {v.versionNumber}) et je l’accepte.</span>
            </label>
            {accept.error ? <p role="alert" className="text-danger">{acceptError(accept.error)}</p> : null}
            <div>
              <Button type="submit" disabled={!agreed || accept.isPending}>{accept.isPending ? 'Enregistrement…' : 'Accepter la proposition'}</Button>
            </div>
            <p className="text-xs text-ink-faint">Vous souhaitez une modification ? Écrivez-nous dans « Échanges avec LSI » ci-dessous.</p>
          </form>
        )}
      </div>
    </Card>
  );
}
