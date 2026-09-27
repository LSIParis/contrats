import { Badge } from '../../ui/badge.js';
import { Icon } from '../../ui/icons.js';
import { clauseOriginLabel, reviewDecisionLabel, riskLevelLabel } from '../../lib/labels.js';
import { aiSourceList, type ClauseAiMeta } from './structure-api.js';

/** Origine d'une clause ; « Générée par IA » est mise en avant (brief §6). */
export function OriginBadge({ origin }: { origin: string }) {
  if (origin === 'AI') {
    return (
      <Badge tone="warn">
        <Icon name="alert" className="h-3.5 w-3.5" strokeWidth={2} />
        Générée par IA
      </Badge>
    );
  }
  return <Badge tone="muted">{clauseOriginLabel(origin)}</Badge>;
}

const RISK_TONE = { LOW: 'success', MEDIUM: 'warn', HIGH: 'danger' } as const;

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null;
  const tone = RISK_TONE[risk as keyof typeof RISK_TONE] ?? 'neutral';
  return <Badge tone={tone}>{riskLevelLabel(risk)}</Badge>;
}

/** État de la revue humaine d'une clause IA. */
export function ReviewBadge({ ai }: { ai: ClauseAiMeta }) {
  const d = ai.review?.decision;
  if (d === 'APPROVED') {
    return (
      <Badge tone="success">
        <Icon name="checkCircle" className="h-3.5 w-3.5" strokeWidth={2} />
        {reviewDecisionLabel(d)}
      </Badge>
    );
  }
  if (d === 'REJECTED') {
    return (
      <Badge tone="danger">
        <Icon name="xCircle" className="h-3.5 w-3.5" strokeWidth={2} />
        {reviewDecisionLabel(d)}
      </Badge>
    );
  }
  return (
    <Badge tone="warn">
      <Icon name="clock" className="h-3.5 w-3.5" strokeWidth={2} />
      À valider
    </Badge>
  );
}

/** Justification et sources citées par le fournisseur (jamais d'URL inventée : liste issue des métadonnées). */
export function AiJustification({ ai }: { ai: Pick<ClauseAiMeta, 'justification' | 'sources'> }) {
  const sources = aiSourceList(ai.sources);
  if (!ai.justification && sources.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded border border-line bg-page px-3 py-2 text-13 text-ink-muted">
      {ai.justification && (
        <p><span className="font-button text-ink">Justification : </span>{ai.justification}</p>
      )}
      {sources.length > 0 && (
        <div>
          <span className="font-button text-ink">Sources : </span>
          <ul className="ml-4 list-disc">
            {sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{s.title}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
