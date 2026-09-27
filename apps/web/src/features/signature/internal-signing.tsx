import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Card } from '../../ui/card.js';
import { EmbeddedSigning, type SigningSession } from './embedded-signing.js';

interface Signer { party: string; email: string; status?: string }

const IN_PROGRESS = ['PENDING_SIGNATURE', 'PARTIALLY_SIGNED'];
const PENDING = ['SENT', 'VIEWED', 'PENDING'];

/**
 * Signature au nom de LSI-Maintenance par le signataire interne connecté
 * (contracts.signInternal), sans quitter l'application. L'API ne rend que
 * l'URL du signataire QUI EST la personne connectée.
 */
export function InternalSigning({ contractId, reference, status, signers, me }: {
  contractId: string;
  reference: string;
  status: string;
  signers: Signer[];
  me: Me | undefined;
}) {
  const qc = useQueryClient();
  if (!IN_PROGRESS.includes(status) || !allows(me, 'contracts.signInternal') || !me?.email) return null;
  const mine = signers.find((s) => s.party === 'LSI' && s.email.toLowerCase() === me.email!.toLowerCase());
  if (!mine || (mine.status && !PENDING.includes(mine.status))) return null;
  return (
    <Card title="Votre signature (LSI-Maintenance)">
      <EmbeddedSigning
        load={() => apiGet<SigningSession>(`/v1/contracts/${contractId}/signing`)}
        buttonLabel="Signer au nom de LSI-Maintenance"
        frameTitle={`Signature électronique du contrat ${reference}`}
        onDone={() => {
          void qc.invalidateQueries({ queryKey: ['contract', contractId] });
          void qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
        }}
      />
    </Card>
  );
}
