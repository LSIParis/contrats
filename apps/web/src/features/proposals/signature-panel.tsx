import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { ErrorNote } from '../../ui/region-card.js';
import { useToast } from '../../ui/toast.js';
import { proposalsApi, type ProposalDetail } from './proposal-api.js';
import { ACCEPTANCE_MODE_LABELS, formatDateTime, label, SIGNATURE_STATUS_LABELS } from './proposal-labels.js';

/**
 * Acceptation, signature DocuSeal et conversion en contrat (brief §12.6-12.7).
 * Les relances sont des actions techniques : renvoi en signature si DocuSeal
 * était indisponible à l'acceptation, nouvelle conversion quand le contrat
 * type manquant a été associé (slug, `/proposal-admin/contract-templates`).
 */
export function SignaturePanel({ detail, me, onRefresh }: { detail: ProposalDetail; me: Me | undefined; onRefresh: () => void }) {
  const toast = useToast();
  const p = detail.proposal;
  const s = detail.signature;
  const startSig = useMutation({
    mutationFn: () => proposalsApi.startSignature(p.id),
    onSuccess: () => { toast.show('Soumission DocuSeal relancée.', 'success'); onRefresh(); },
  });
  const convert = useMutation({
    mutationFn: () => proposalsApi.convert(p.id),
    onSuccess: () => { toast.show('Conversion relancée.', 'success'); onRefresh(); },
  });
  const canStart = detail.allowedEvents.includes('START_SIGNATURE') && allows(me, 'proposals.send');
  const canConvert = detail.allowedEvents.includes('CONVERT') && allows(me, 'proposals.convert');

  const hashes: [string, string | null][] = s
    ? [['PDF envoyé en signature', s.sentPdfSha256], ['PDF signé', s.signedPdfSha256], ['Journal d’audit DocuSeal', s.auditTrailSha256]]
    : [];

  return (
    <section aria-label="Signature et conversion" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-15 font-title text-ink">Acceptation</h2>
        <dl className="grid gap-x-6 gap-y-1 text-13 sm:grid-cols-2">
          <div><dt className="inline text-ink-faint">Mode : </dt><dd className="inline">{ACCEPTANCE_MODE_LABELS[p.acceptanceMode] ?? p.acceptanceMode}</dd></div>
          <div><dt className="inline text-ink-faint">Acceptée le : </dt><dd className="inline">{formatDateTime(p.acceptedAt)}</dd></div>
          <div><dt className="inline text-ink-faint">Signée le : </dt><dd className="inline">{formatDateTime(p.signedAt)}</dd></div>
          <div><dt className="inline text-ink-faint">Convertie le : </dt><dd className="inline">{formatDateTime(p.convertedAt)}</dd></div>
        </dl>
        {p.declineReasonCode && <p className="text-13 text-danger">Refusée par le client ({p.declineReasonCode}){p.declineReason ? ` : ${p.declineReason}` : ''}.</p>}
        {p.withdrawReason && <p className="text-13 text-ink-muted">Retirée : {p.withdrawReason}</p>}
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-15 font-title text-ink">Signature électronique</h2>
        {!s ? (
          <p className="text-13 text-ink-muted">
            {p.acceptanceMode === 'CLICK_ACCEPT' ? 'Acceptation par clic : pas de soumission DocuSeal (preuve : e-mail vérifié, horodatage, IP, empreinte).' : 'Aucune soumission : elle est créée quand le signataire accepte la proposition.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-13">
              <Badge tone={s.status === 'COMPLETED' ? 'success' : s.status === 'FAILED' || s.status === 'DECLINED' || s.status === 'EXPIRED' ? 'danger' : 'info'}>{label(SIGNATURE_STATUS_LABELS, s.status)}</Badge>
              <span className="text-ink-muted">créée le {formatDateTime(s.createdAt)} — {s.delivery === 'EMBEDDED' ? 'signature intégrée à la page' : 'lien par e-mail'}</span>
            </div>
            {s.errorMessage && <p className="rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">{s.errorMessage}</p>}
            <dl className="flex flex-col gap-1 text-13">
              {hashes.filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="flex flex-wrap gap-2"><dt className="text-ink-faint">{k} (SHA-256) :</dt><dd className="break-all font-mono text-xs">{v}</dd></div>
              ))}
            </dl>
          </>
        )}
        {canStart && (
          <div><Button size="sm" disabled={startSig.isPending} onClick={() => startSig.mutate()}>Relancer l’envoi en signature</Button></div>
        )}
        <ErrorNote>{errorMessage(startSig.error)}</ErrorNote>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-15 font-title text-ink">Contrat</h2>
        {p.contractId ? (
          <p className="text-13">
            Contrat créé à partir de la proposition signée (barème initial = configuration figée).{' '}
            <Link to={`/contracts/${p.contractId}`} className="font-button text-primary hover:underline">Ouvrir le contrat généré</Link>
          </p>
        ) : (
          <p className="text-13 text-ink-muted">La conversion en contrat est automatique à la signature (contrat en brouillon, origine « proposition »).</p>
        )}
        {p.conversionError && (
          <div role="alert" className="flex flex-col gap-1 rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">
            <p><strong>Conversion en échec :</strong> {p.conversionError}</p>
            <p>
              La conversion exige un contrat type publié portant le slug du modèle de proposition.{' '}
              <Link to="/proposal-admin/contract-templates" className="font-button underline">Associer les contrats types</Link>
            </p>
          </div>
        )}
        {canConvert && (
          <div><Button size="sm" disabled={convert.isPending} onClick={() => convert.mutate()}>{p.conversionError ? 'Relancer la conversion' : 'Convertir en contrat'}</Button></div>
        )}
        <ErrorNote>{errorMessage(convert.error)}</ErrorNote>
      </div>
    </section>
  );
}
