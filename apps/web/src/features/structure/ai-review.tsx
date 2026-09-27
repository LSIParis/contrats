import { useState } from 'react';
import { errorMessage } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Icon } from '../../ui/icons.js';
import { Input } from '../../ui/input.js';
import { useReviewClause, type StructureClause } from './structure-api.js';

/**
 * Bandeau permanent tant qu'une clause IA n'est pas validée (brief §6.5,
 * V2-AI) : la soumission en revue interne est bloquée par l'API.
 */
export function AiReviewBanner({ count }: { count: number }) {
  if (!count) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-warn bg-warn-bg px-4 py-3 text-sm text-warn">
      <Icon name="alert" className="mt-0.5 h-4 w-4" />
      <p>
        <strong>Projet généré par IA — à faire valider par un juriste.</strong>{' '}
        {count} clause{count > 1 ? 's' : ''} générée{count > 1 ? 's' : ''} par IA reste{count > 1 ? 'nt' : ''} à valider :
        la soumission en revue interne est bloquée tant que chaque clause n’a pas été validée.
      </p>
    </div>
  );
}

/** Validation humaine d'une clause IA (permission clauses.validateAi). */
export function ClauseReviewControls({ contractId, clause }: { contractId: string; clause: StructureClause }) {
  const review = useReviewClause(contractId);
  const [comment, setComment] = useState('');
  const id = `review-${clause.id}`;
  const act = (decision: 'APPROVED' | 'REJECTED') => review.mutate({ clauseId: clause.id, decision, comment }, { onSuccess: () => setComment('') });
  return (
    <div className="flex flex-col gap-2 rounded border border-line bg-page px-3 py-2">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">Commentaire de revue — {clause.title} (facultatif)</label>
      <Input id={id} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={review.isPending} aria-label={`Valider la clause ${clause.title}`} onClick={() => act('APPROVED')}>
          Valider la clause
        </Button>
        <Button type="button" size="sm" variant="danger-ghost" disabled={review.isPending} aria-label={`Rejeter la clause ${clause.title}`} onClick={() => act('REJECTED')}>
          Rejeter
        </Button>
      </div>
      {review.error && <p role="alert" className="text-sm text-danger">{errorMessage(review.error)}</p>}
    </div>
  );
}
