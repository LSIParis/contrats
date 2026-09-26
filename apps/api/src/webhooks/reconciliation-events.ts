import type { NormalizedSignatureEvent, ProviderSubmissionState, SignatureEventKind } from '@lsi/domain';

/**
 * État relu chez le provider → événements normalisés. (EC-06, brief §7)
 *
 * La réconciliation ne réinvente pas les règles : elle fabrique les
 * événements qu'AURAIENT dû apporter les webhooks perdus, et les fait passer
 * par le MÊME chemin (`DocusealWebhookService.process`). Même idempotence,
 * mêmes gardes d'ordre, même journal `signature_events`.
 *
 * Identifiants `docuseal:reconcile:…` : déterministes (une seconde passe de
 * réconciliation est dédupliquée par la contrainte UNIQUE), et DISTINCTS de
 * ceux des webhooks — si le vrai webhook arrive ensuite, il est journalisé
 * lui aussi, et ce sont les gardes monotones (signataire déjà SIGNED,
 * demande close) qui l'empêchent de rejouer l'effet.
 *
 * Ordre produit : consultations, signatures (par date), refus, puis
 * l'événement de niveau submission — l'ordre « naturel », même si les
 * gardes rendent le résultat indépendant de l'ordre.
 */
export function reconciliationEvents(state: ProviderSubmissionState, now = new Date()): NormalizedSignatureEvent[] {
  const snapshot = JSON.parse(JSON.stringify(state)) as unknown;
  const base = (kind: SignatureEventKind, suffix: string, occurredAt: Date | null) => ({
    eventId: `docuseal:reconcile:${kind}:${state.providerSubmissionId}:${suffix}`,
    kind,
    occurredAt: occurredAt ?? now,
    providerSubmissionId: state.providerSubmissionId,
    declineReason: null,
    ip: null,
    userAgent: null,
    untrustedMetadata: {},
    rawPayload: { source: 'reconciliation', state: snapshot },
  });

  const events: NormalizedSignatureEvent[] = [];
  const bySigner = (kind: SignatureEventKind, s: ProviderSubmissionState['submitters'][number], at: Date | null) => ({
    ...base(kind, s.providerSubmitterId, at),
    providerSubmitterId: s.providerSubmitterId,
    externalSignerId: s.externalId,
    submitterEmail: s.email,
  });

  for (const s of state.submitters) {
    if (s.status === 'OPENED' || s.openedAt) events.push(bySigner('FORM_VIEWED', s, s.openedAt));
  }
  const completed = state.submitters
    .filter((s) => s.status === 'COMPLETED')
    .sort((a, b) => (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0));
  for (const s of completed) events.push(bySigner('FORM_COMPLETED', s, s.completedAt));
  for (const s of state.submitters.filter((x) => x.status === 'DECLINED')) {
    events.push({ ...bySigner('FORM_DECLINED', s, s.declinedAt), declineReason: s.declineReason });
  }

  const level = (kind: SignatureEventKind, at: Date | null): NormalizedSignatureEvent => ({
    ...base(kind, 'submission', at),
    providerSubmitterId: '',
    externalSignerId: null,
    submitterEmail: null,
  });
  if (state.status === 'COMPLETED') events.push(level('SUBMISSION_COMPLETED', state.completedAt));
  if (state.status === 'EXPIRED') events.push(level('SUBMISSION_EXPIRED', state.expireAt));

  return events;
}
