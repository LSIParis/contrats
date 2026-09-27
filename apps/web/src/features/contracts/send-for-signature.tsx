import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../../lib/api.js';
import { partyLabel, SIGNING_ORDER_CODES, signingOrderLabel } from '../../lib/labels.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { signingErrorMessage } from '../signature/embedded-signing.js';
import { signatureUnavailableReason, type SignatureAvailability } from '../signature/signature-availability.js';

interface Signer { id: string; party: string; fullName: string; email: string; signingOrder: number; }

/**
 * Envoi en signature (lot 4) : ordre des signataires et mode de remise.
 * Sans choix explicite, l'API applique les paramètres de l'organisation
 * (`signature.defaultOrder`, `signature.expireDays`) — d'où l'option
 * « par défaut », qui n'envoie rien.
 */
export function SendForSignature({
  contractId, signers, allowedActions, roles, availability,
}: {
  contractId: string; signers: Signer[]; allowedActions: string[]; roles: string[];
  availability?: SignatureAvailability;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [order, setOrder] = useState('');
  const [delivery, setDelivery] = useState<'EMAIL' | 'EMBEDDED'>('EMAIL');
  const [expire, setExpire] = useState('');

  const send = useMutation({
    mutationFn: () =>
      apiPost(`/v1/contracts/${contractId}/send-for-signature`, {
        ...(order ? { signingOrder: order } : {}),
        delivery,
        ...(expire.trim() ? { expireInDays: Number(expire) } : {}),
      }, {
        headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['allowed-actions', contractId] });
      qc.invalidateQueries({ queryKey: ['lifecycle', contractId] });
      setConfirming(false);
    },
  });

  const canSend =
    allowedActions.includes('SEND_FOR_SIGNATURE') &&
    roles.some((r) => ['MSP_ADMIN', 'ACCOUNT_MANAGER'].includes(r));
  if (!canSend) return null;

  const unavailable = signatureUnavailableReason(availability);
  const error = send.error ? signingErrorMessage(send.error) : undefined;
  const sorted = [...signers].sort((a, b) => a.signingOrder - b.signingOrder);
  const expireOk = !expire.trim() || (/^\d+$/.test(expire.trim()) && Number(expire) >= 1 && Number(expire) <= 180);

  return (
    <div className="space-y-2">
      {!confirming ? (
        <Button type="button" disabled={!!unavailable} title={unavailable ?? undefined} onClick={() => setConfirming(true)}>
          Envoyer en signature
        </Button>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-line p-4">
          <p className="text-sm font-button">Confirmer l’envoi en signature</p>
          <p className="text-sm text-ink-muted">Signataires définis sur le contrat :</p>
          <ul className="text-sm">
            {sorted.map((s) => (
              <li key={s.id}>{s.signingOrder + 1}. {s.fullName} <span className="text-ink-faint">({partyLabel(s.party)})</span> — {s.email}</li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Ordre de signature" htmlFor="sig-order">
              <Select id="sig-order" value={order} onChange={(e) => setOrder(e.target.value)}>
                <option value="">Par défaut (paramètre de l’organisation)</option>
                {SIGNING_ORDER_CODES.map((o) => <option key={o} value={o}>{signingOrderLabel(o)}</option>)}
              </Select>
            </Field>
            <Field label="Expiration (jours)" htmlFor="sig-expire" hint="Vide : délai par défaut de l’organisation." error={expireOk ? undefined : 'Entre 1 et 180 jours.'}>
              <Input id="sig-expire" inputMode="numeric" value={expire} onChange={(e) => setExpire(e.target.value)} />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-xs+ font-button text-ink-muted">Mode de signature</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="sig-delivery" checked={delivery === 'EMAIL'} onChange={() => setDelivery('EMAIL')} />
              Lien envoyé par e-mail à chaque signataire
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="sig-delivery" checked={delivery === 'EMBEDDED'} onChange={() => setDelivery('EMBEDDED')} />
              Signature intégrée (dans l’application et l’espace client)
            </label>
          </fieldset>
          <a href={`/v1/contracts/${contractId}/preview.pdf`} target="_blank" rel="noopener" className="text-sm text-primary hover:underline">Aperçu PDF</a>
          <div className="flex gap-2">
            <Button type="button" disabled={send.isPending || !expireOk} onClick={() => send.mutate()}>
              {send.isPending ? 'Envoi…' : 'Confirmer l’envoi'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Annuler</Button>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
