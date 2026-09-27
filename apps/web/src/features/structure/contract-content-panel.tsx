import { Link } from 'react-router-dom';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { buttonClass } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Spinner } from '../../ui/spinner.js';
import { Icon } from '../../ui/icons.js';
import { AiDraftDialog } from '../ai/ai-draft-dialog.js';
import { ClauseAiActions } from '../ai/clause-ai-actions.js';
import { MissingClausesPanel } from '../ai/missing-clauses-panel.js';
import { AiPrivacyNotice, AiUnavailable } from '../ai/ai-notice.js';
import { aiUnavailableReason, useAiAvailability } from '../ai/ai-api.js';
import { AiJustification, OriginBadge, ReviewBadge, RiskBadge } from './clause-badges.js';
import { AiReviewBanner, ClauseReviewControls } from './ai-review.js';
import { DiffSummary } from './diff-summary.js';
import { VariablesPanel } from './variables-panel.js';
import { usedVariables, variableRows } from './variables.js';
import { useStructure } from './structure-api.js';

/**
 * Onglet « Contenu » de la fiche contrat : clauses (avec origine, risque et
 * revue des clauses IA), assistance IA, variables et écarts au contrat type.
 * L'édition se fait sur /contracts/:id/structure.
 */
export function ContractContentPanel({ contractId, currentVersionId, imported, allowedActions, me }: {
  contractId: string;
  currentVersionId: string | null;
  imported: boolean;
  allowedActions: string[];
  me: Me | undefined;
}) {
  const structure = useStructure(contractId);
  const canAi = allows(me, 'contracts.aiDraft');
  const ai = useAiAvailability(canAi);
  const editable = allowedActions.includes('EDIT_CONTENT') && allows(me, 'contracts.write');
  const canReview = allows(me, 'clauses.validateAi');
  const aiReason = ai.isLoading ? 'Vérification de la disponibilité de l’IA…' : aiUnavailableReason(ai.data);
  const s = structure.data;

  const links = (
    <div className="flex flex-wrap gap-3 text-sm">
      {editable && (
        <Link to={`/contracts/${contractId}/structure`} className={buttonClass('primary', 'sm')}>Modifier le contenu</Link>
      )}
      {currentVersionId && (
        <>
          <a href={`/v1/contracts/${contractId}/preview.pdf`} target="_blank" rel="noopener" className="text-primary hover:underline">Aperçu PDF</a>
          <a href={`/v1/contracts/${contractId}/export.pdf`} className="text-primary hover:underline">Télécharger PDF</a>
          <a href={`/v1/contracts/${contractId}/export.docx`} className="text-primary hover:underline">Télécharger DOCX</a>
        </>
      )}
      <Link to={`/contracts/${contractId}/versions`} className="text-primary hover:underline">Versions du contenu</Link>
    </div>
  );

  if (structure.isLoading) return <Spinner />;
  if (structure.error || !s) {
    return <Card title="Contenu">{links}<p role="alert" className="mt-2 text-sm text-danger">Contenu structuré indisponible.</p></Card>;
  }

  const rows = variableRows(usedVariables([...s.clauses, ...s.annexes]), s.variables.values ?? {}, s.variables.definitions ?? {}, s.variables.custom ?? {});
  const unreviewed = s.unreviewedAiClauses ?? s.clauses.filter((c) => c.ai && c.ai.review?.decision !== 'APPROVED').length;

  return (
    <div className="flex flex-col gap-4">
      <Card title={`Contenu${s.versionNumber != null ? ` — version ${s.versionNumber}` : ''}`}>{links}</Card>
      <AiReviewBanner count={unreviewed} />

      {canAi && (
        <Card title="Assistance IA">
          <div className="flex flex-col gap-3">
            {aiReason ? <AiUnavailable reason={aiReason} /> : <AiPrivacyNotice provider={ai.data?.provider} />}
            <div className="flex flex-wrap items-start gap-3">
              {editable && <AiDraftDialog contractId={contractId} provider={ai.data?.provider} disabledReason={aiReason} hasClauses={s.clauses.length > 0} />}
              {s.clauses.length > 0 && <MissingClausesPanel contractId={contractId} disabledReason={aiReason} />}
            </div>
          </div>
        </Card>
      )}

      <Card title="Clauses">
        {s.clauses.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {imported ? 'Contrat importé : son contenu est le document signé (onglet Documents).' : 'Aucun contenu rédigé.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {s.clauses.map((c, i) => (
              <li key={c.id} className={`flex flex-col gap-2 rounded border px-4 py-3 ${c.origin === 'AI' ? 'border-warn' : 'border-line'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-title text-ink">Article {i + 1} — {c.title}</h3>
                  <OriginBadge origin={c.origin} />
                  {c.ai && <RiskBadge risk={c.ai.risk} />}
                  {c.ai && <ReviewBadge ai={c.ai} />}
                </div>
                <div className="prose max-w-none text-sm" dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
                {c.ai && <AiJustification ai={c.ai} />}
                {c.ai?.review?.comment && (
                  <p className="text-13 text-ink-muted"><Icon name="message" className="mr-1 inline h-3.5 w-3.5" />Revue : {c.ai.review.comment}</p>
                )}
                {c.ai && canReview && c.ai.review?.decision !== 'APPROVED' && <ClauseReviewControls contractId={contractId} clause={c} />}
                {canAi && (
                  <ClauseAiActions contractId={contractId} clause={c} structure={s} canReplace={editable} provider={ai.data?.provider} disabledReason={aiReason} />
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Variables"><VariablesPanel rows={rows} readOnly /></Card>
        <Card title="Écarts par rapport au contrat type"><DiffSummary diff={s.diff} /></Card>
      </div>
    </div>
  );
}
