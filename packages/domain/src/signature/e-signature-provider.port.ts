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

/** Un signataire, tel que le domaine le décrit — pas tel que DocuSeal l'attend. */
export interface SubmitterCommand {
  readonly party: 'LSI' | 'CLIENT';
  /** NOTRE contract_signers.id. Clé de rapprochement des webhooks (§11.5). */
  readonly externalId: string;
  readonly fullName: string;
  readonly email: string;
  readonly signingOrder: number;
  readonly requireEmail2fa: boolean;
  readonly fields: readonly SubmitterField[];
}

export interface SubmitterField {
  readonly name: string;
  readonly defaultValue: string;
  /**
   * TOUJOURS true pour les valeurs contractuelles.
   *
   * `default_value` seul est modifiable par le signataire depuis les
   * devtools : DocuSeal n'applique l'immuabilité que si le champ est marqué
   * readonly CÔTÉ SERVEUR. Un montant contractuel pré-rempli mais éditable
   * serait une faille béante.
   */
  readonly readonly: boolean;
}

export interface CreateSubmissionCommand {
  /** Le PDF déjà rendu et haché (§11.2). */
  readonly pdf: Buffer;
  readonly documentName: string;
  /** 'preserved' : LSI signe d'abord, le client ensuite (RM-13). */
  readonly order: 'preserved' | 'random';
  readonly expireAt: Date;
  readonly subject: string;
  readonly body: string;
  readonly completedRedirectUrl: string;
  readonly submitters: readonly SubmitterCommand[];
  /**
   * Scope, à des fins de DIAGNOSTIC uniquement.
   *
   * Elle revient dans les webhooks, où elle sert de SONDE de divergence —
   * jamais d'autorisation (§11.4). Le scope d'un webhook se résout depuis
   * notre base, pas depuis ce que le provider nous renvoie.
   */
  readonly metadata: Record<string, string>;
}

export interface ProviderSubmission {
  readonly providerSubmissionId: string;
  readonly submitters: readonly {
    readonly externalId: string | null;
    readonly providerSubmitterId: string;
    readonly slug: string;
  }[];
}

/** Erreur du provider. `retryable` décide du code HTTP et du réessai. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ESignatureProvider {
  readonly name: ProviderName;

  /**
   * Crée la demande de signature chez le provider.
   *
   * Le contrat ne passe PENDING_SIGNATURE qu'après le retour de cet appel
   * (EC-04) : on ne prétend jamais avoir envoyé ce qui n'est pas parti.
   */
  createSubmission(cmd: CreateSubmissionCommand): Promise<ProviderSubmission>;

  /**
   * Retrouve une submission par notre clé d'idempotence.
   *
   * Indispensable avant tout réessai après timeout (§11.8) : la submission
   * a peut-être été créée malgré l'absence de réponse. Sans cette
   * vérification, le client reçoit DEUX invitations à signer.
   */
  findSubmissionByExternalId(externalId: string): Promise<ProviderSubmission | null>;

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
