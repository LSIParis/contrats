/**
 * Port de signature électronique. (§11.1)
 *
 * Le domaine connaît CETTE interface, pas DocuSeal. Aucun type du provider
 * ne traverse cette frontière : ni template_id, ni slug, ni la forme du
 * payload webhook.
 *
 * Le jour où LSI passe à Yousign — parce qu'un client grand compte exige une
 * signature avancée eIDAS (§13.7) — on écrit un second adaptateur et le
 * domaine ne bouge pas.
 */

export type ProviderName = 'DOCUSEAL';

/** Événements normalisés. Le vocabulaire est le NÔTRE, pas celui du provider. */
export type SignatureEventKind =
  | 'FORM_VIEWED'
  | 'FORM_STARTED'
  | 'FORM_COMPLETED'
  | 'FORM_DECLINED'
  | 'SUBMISSION_COMPLETED'
  | 'SUBMISSION_EXPIRED';

/**
 * Un événement webhook, normalisé et déjà vérifié.
 *
 * Ne contient AUCUN identifiant de scope : c'est délibéré. Le scope se
 * résout depuis notre base via `providerSubmissionId` (§11.4). Si ce type
 * portait un tenantId, quelqu'un finirait par s'en servir — et le scope
 * viendrait alors du réseau.
 */
export interface NormalizedSignatureEvent {
  /** Dérivé de façon déterministe : porte l'idempotence (EC-05). */
  readonly eventId: string;
  readonly kind: SignatureEventKind;
  readonly occurredAt: Date;

  /** LA clé de résolution du scope. */
  readonly providerSubmissionId: string;
  readonly providerSubmitterId: string;
  /** Notre contract_signers.id, tel que posé à la création (§11.3). */
  readonly externalSignerId: string | null;

  readonly submitterEmail: string | null;
  readonly declineReason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;

  /**
   * Metadata brute du provider. À des fins de DIAGNOSTIC et de détection de
   * divergence uniquement — jamais d'autorisation. Elle vient du réseau.
   */
  readonly untrustedMetadata: Record<string, unknown>;

  readonly rawPayload: unknown;
}

export interface WebhookVerification {
  readonly valid: boolean;
  readonly reason?: string;
}

export interface ESignatureProvider {
  readonly name: ProviderName;

  /**
   * Vérifie la signature sur le CORPS BRUT.
   *
   * Prend un Buffer, pas un objet : un HMAC calculé sur du JSON reparsé
   * serait faux dès que l'émetteur ordonne ses clés ou espace autrement.
   * La signature porte sur les octets reçus.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerification;

  /** Traduit le payload du provider vers notre vocabulaire. */
  parseWebhook(payload: unknown): NormalizedSignatureEvent | null;
}
