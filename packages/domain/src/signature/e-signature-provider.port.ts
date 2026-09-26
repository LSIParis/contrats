/**
 * Port de signature électronique. (§11.1, docs/contrats/06-docuseal.md)
 *
 * Le domaine connaît CETTE interface, pas DocuSeal. Aucun type du provider
 * ne traverse cette frontière : ni template_id numérique, ni slug d'URL, ni
 * la forme du payload webhook.
 *
 * Le jour où LSI doit proposer une signature avancée ou qualifiée eIDAS
 * (client grand compte, secteur réglementé — voir 06-docuseal.md §eIDAS),
 * on écrit un second adaptateur derrière ce port et le domaine ne bouge pas.
 *
 * Deux voies de création coexistent :
 *   - NOMINALE  : `createSubmission` — le PDF figé de la version envoyée,
 *     champs posés par balises textuelles (voir text-tags.ts). Le document
 *     signé est EXACTEMENT celui dont l'empreinte est stockée.
 *   - SECONDAIRE : `createSubmissionFromTemplate` — un modèle figé côté
 *     provider, pré-rempli. Réservée aux formulaires standard récurrents.
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
  /**
   * Identifiant du signataire chez le provider. Chaîne VIDE pour les
   * événements de niveau submission (`SUBMISSION_*`), qui ne concernent pas
   * un signataire en particulier.
   */
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

/** Le PDF signé et sa piste d'audit, rapatriés du provider. */
export interface SignedDocuments {
  readonly signedPdf: Buffer;
  /** Peut être absent si le provider n'expose pas de piste d'audit. */
  readonly auditTrail: Buffer | null;
}

/**
 * Les documents d'une submission complétée, rapatriés en OCTETS. (§11.6)
 *
 * Jamais d'URL ici : une URL du provider est une promesse qu'il tiendra
 * peut-être dans dix ans. Les octets, eux, sont copiés chez nous, hachés,
 * et ne dépendent plus de personne.
 */
export interface CompletedDocuments {
  /** Tous les documents fusionnés en un seul PDF (documents?merge=true). */
  readonly mergedPdf: Buffer;
  /** Journal d'audit du provider (audit_log_url), s'il est exposé. */
  readonly auditLogPdf: Buffer | null;
  /**
   * Document combiné (documents + journal d'audit) si l'instance le produit
   * (combined_document_url, réglage de compte). Souvent null.
   */
  readonly combinedPdf: Buffer | null;
  /** Chaque document signé, séparément, dans l'ordre du provider. */
  readonly documents: readonly { readonly name: string; readonly pdf: Buffer }[];
}

/**
 * Politique d'ordre de signature.
 *
 *   CLIENT_THEN_LSI — DÉFAUT du brief : le client signe, puis LSI contresigne.
 *                     LSI ne s'engage qu'une fois l'accord du client acquis.
 *   LSI_THEN_CLIENT — LSI signe d'abord (règle historique RM-13).
 *   PARALLEL        — tous invités d'emblée (`order: random` chez DocuSeal).
 *   AS_DEFINED      — respecte `SubmitterCommand.signingOrder` tel quel
 *                     (ordre saisi sur le contrat, bloc Signataires).
 */
export type SigningOrderPolicy = 'CLIENT_THEN_LSI' | 'LSI_THEN_CLIENT' | 'PARALLEL' | 'AS_DEFINED';

export const DEFAULT_SIGNING_ORDER: SigningOrderPolicy = 'CLIENT_THEN_LSI';

/**
 * Mode de remise de l'invitation.
 *
 *   EMAIL    — le provider envoie le lien de signature par e-mail.
 *   EMBEDDED — aucun e-mail : la signature se fait DANS l'application via
 *              `embedSrc` (composant web `<docuseal-form data-src=…>`).
 */
export type SignatureDelivery = 'EMAIL' | 'EMBEDDED';

/**
 * Politique de relance. CONSOMMÉE PAR NOTRE PLANIFICATEUR, pas transmise :
 * l'API DocuSeal n'a aucun paramètre de relance à la création (vérifié le
 * 2026-09-26 dans l'OpenAPI publique). Une relance = `remindSubmitter`.
 */
export interface ReminderPolicy {
  readonly firstAfterDays: number;
  readonly repeatEveryDays: number;
  readonly maxReminders: number;
}

/** Un signataire, tel que le domaine le décrit — pas tel que DocuSeal l'attend. */
export interface SubmitterCommand {
  readonly party: 'LSI' | 'CLIENT';
  /**
   * Libellé de rôle du signataire (ex. « Client », « LSI Maintenance »).
   *
   * DocuSeal apparie les champs du document aux signataires PAR CE RÔLE :
   * une balise `{{Signature Client;role=Client;type=signature}}` va au
   * signataire de rôle « Client ». Le même libellé doit donc servir à la
   * balise dans le document ET au submitter ici — sinon le signataire n'a
   * aucun champ à signer. Voir `signerRoleLabel()` (text-tags.ts).
   */
  readonly roleLabel: string;
  /** NOTRE contract_signers.id. Clé de rapprochement des webhooks (§11.5). */
  readonly externalId: string;
  readonly fullName: string;
  readonly email: string;
  /** 0 = premier. Même valeur = groupe signant en parallèle. */
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

/** Options communes aux deux voies de création. */
interface SubmissionOptions {
  readonly expireAt: Date;
  readonly subject: string;
  readonly body: string;
  readonly completedRedirectUrl: string;
  /**
   * `false` désactive l'envoi des emails de demande de signature.
   *
   * Défaut (non renseigné) = envoi actif, sauf `delivery: 'EMBEDDED'` qui
   * force `false`. Utile à `false` pour les tests (ne pas spammer).
   */
  readonly sendEmail?: boolean;
  /** Défaut : EMAIL. */
  readonly delivery?: SignatureDelivery;
  /**
   * Politique d'ordre. Si absente : `AS_DEFINED` quand `order` est fourni
   * (appelants historiques), sinon `DEFAULT_SIGNING_ORDER`.
   */
  readonly signingOrder?: SigningOrderPolicy;
  /**
   * Forme historique de l'ordre, conservée pour les appelants existants.
   * 'preserved' + signingOrder des submitters ≡ `AS_DEFINED`.
   */
  readonly order?: 'preserved' | 'random';
  readonly reminders?: ReminderPolicy;
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

/** VOIE NOMINALE : le PDF figé de la version (POST /submissions/pdf). */
export interface CreateSubmissionCommand extends SubmissionOptions {
  /** Le PDF déjà rendu et haché (§11.2), balises textuelles incluses. */
  readonly pdf: Buffer;
  /**
   * SHA-256 (hex) de `pdf`, tel que stocké sur la version AVANT l'envoi.
   * L'adaptateur le revérifie : envoyer un octet différent de celui dont on
   * a gardé l'empreinte ruinerait la valeur probante (§11.2).
   * Optionnel pour les appelants historiques.
   */
  readonly pdfSha256?: string;
  readonly documentName: string;
}

/** VOIE SECONDAIRE : un modèle figé chez le provider (POST /submissions). */
export interface CreateTemplateSubmissionCommand extends SubmissionOptions {
  /** Identifiant du modèle chez le provider (opaque pour le domaine). */
  readonly providerTemplateId: string;
}

export interface ProviderSubmission {
  readonly providerSubmissionId: string;
  readonly submitters: readonly {
    readonly externalId: string | null;
    readonly providerSubmitterId: string;
    readonly slug: string;
    /** URL de signature intégrable (`embed_src`), si le provider la donne. */
    readonly embedSrc?: string | null;
  }[];
}

/** État d'une submission, tel que relu chez le provider (réconciliation). */
export type ProviderSubmissionStatus = 'PENDING' | 'COMPLETED' | 'DECLINED' | 'EXPIRED';
export type ProviderSubmitterStatus = 'AWAITING' | 'SENT' | 'OPENED' | 'COMPLETED' | 'DECLINED';

export interface ProviderSubmissionState {
  readonly providerSubmissionId: string;
  readonly status: ProviderSubmissionStatus;
  readonly completedAt: Date | null;
  readonly expireAt: Date | null;
  readonly submitters: readonly {
    readonly providerSubmitterId: string;
    readonly externalId: string | null;
    readonly email: string | null;
    readonly status: ProviderSubmitterStatus;
    readonly openedAt: Date | null;
    readonly completedAt: Date | null;
    readonly declinedAt: Date | null;
    readonly declineReason: string | null;
  }[];
}

/** Résultat de la sonde de disponibilité (démarrage, /readyz). */
export interface ProviderReadiness {
  /** Le provider a répondu en HTTP (quel que soit le code). */
  readonly reachable: boolean;
  /** Le jeton est accepté (2xx sur un appel authentifié). */
  readonly tokenValid: boolean;
  /** Explication lisible, SANS secret. */
  readonly detail: string;
}

/**
 * Catégorie d'erreur provider — décide du code HTTP renvoyé et du réessai.
 *
 *   AUTH        jeton absent/invalide (401/403)          → ne pas réessayer
 *   VALIDATION  payload refusé (400/422)                 → ne pas réessayer
 *   NOT_FOUND   ressource inconnue (404)                 → ne pas réessayer
 *   TIMEOUT     pas de réponse dans le délai             → réessayer APRÈS
 *               vérification (la création a pu aboutir, §11.8)
 *   UNAVAILABLE réseau, 429, 5xx                         → réessayer
 *   NOT_READY   documents pas encore finalisés           → réessayer plus tard
 *   PROTOCOL    réponse inattendue (forme, type MIME)    → ne pas réessayer
 */
export type ProviderErrorCode =
  | 'AUTH'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'NOT_READY'
  | 'PROTOCOL';

/** Erreur du provider. `retryable` décide du code HTTP et du réessai. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: ProviderErrorCode = retryable ? 'UNAVAILABLE' : 'PROTOCOL',
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** 401/403 : le jeton d'API est absent, révoqué ou faux. */
export class ProviderAuthError extends ProviderError {
  constructor(message: string, httpStatus: number | null = 401) {
    super(message, false, 'AUTH', httpStatus);
    this.name = 'ProviderAuthError';
  }
}

/** 400/422 : le provider refuse notre payload. Réessayer ne changerait rien. */
export class ProviderValidationError extends ProviderError {
  constructor(
    message: string,
    httpStatus: number,
    /** Message d'erreur du provider, tronqué — utile au diagnostic. */
    readonly providerMessage: string,
  ) {
    super(message, false, 'VALIDATION', httpStatus);
    this.name = 'ProviderValidationError';
  }
}

/** Pas de réponse dans le délai : l'opération a PEUT-ÊTRE abouti. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message: string) {
    super(message, true, 'TIMEOUT', null);
    this.name = 'ProviderTimeoutError';
  }
}

/** Réseau coupé, 429 ou 5xx : leur problème, réessayable. */
export class ProviderUnavailableError extends ProviderError {
  constructor(message: string, httpStatus: number | null) {
    super(message, true, 'UNAVAILABLE', httpStatus);
    this.name = 'ProviderUnavailableError';
  }
}

export interface ESignatureProvider {
  readonly name: ProviderName;

  /**
   * VOIE NOMINALE — crée la demande de signature à partir du PDF figé.
   *
   * Le contrat ne passe PENDING_SIGNATURE qu'après le retour de cet appel
   * (EC-04) : on ne prétend jamais avoir envoyé ce qui n'est pas parti.
   */
  createSubmission(cmd: CreateSubmissionCommand): Promise<ProviderSubmission>;

  /** VOIE SECONDAIRE — crée la demande depuis un modèle figé chez le provider. */
  createSubmissionFromTemplate(cmd: CreateTemplateSubmissionCommand): Promise<ProviderSubmission>;

  /**
   * Retrouve une submission par l'external_id d'un de ses SIGNATAIRES
   * (notre contract_signers.id).
   *
   * Indispensable avant tout réessai après timeout (§11.8) : la submission
   * a peut-être été créée malgré l'absence de réponse. Sans cette
   * vérification, le client reçoit DEUX invitations à signer.
   */
  findSubmissionByExternalId(externalId: string): Promise<ProviderSubmission | null>;

  /** Relit l'état d'une submission (réconciliation sans webhook, EC-06). */
  getSubmission(providerSubmissionId: string): Promise<ProviderSubmissionState>;

  /**
   * Télécharge le PDF signé et sa piste d'audit. (§11.6)
   *
   * @deprecated Préférer `downloadCompletedDocuments`, plus complet. Conservé
   * pour les appelants historiques ; implémenté par-dessus.
   */
  downloadSignedDocuments(providerSubmissionId: string): Promise<SignedDocuments>;

  /**
   * Rapatrie TOUS les documents d'une submission complétée. (§11.6)
   *
   * Dès la signature, on rapatrie et stocke ces preuves chez nous : on ne
   * dépend JAMAIS d'une URL du provider à long terme pour produire une
   * preuve. Un fournisseur peut disparaître ; l'obligation dure 10 ans.
   * Lève `ProviderError('NOT_READY')` si la submission n'est pas complétée.
   */
  downloadCompletedDocuments(providerSubmissionId: string): Promise<CompletedDocuments>;

  /**
   * Sonde de disponibilité : provider joignable ET jeton valide.
   * Ne lève JAMAIS : une sonde qui lève est une sonde qu'on finit par
   * débrancher.
   */
  checkReadiness(): Promise<ProviderReadiness>;

  /**
   * Vérifie l'authenticité d'un webhook sur le CORPS BRUT.
   *
   * Prend un Buffer, pas un objet : un HMAC calculé sur du JSON reparsé
   * serait faux dès que l'émetteur ordonne ses clés ou espace autrement.
   * La signature porte sur les octets reçus.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerification;

  /** Traduit le payload du provider vers notre vocabulaire. */
  parseWebhook(payload: unknown): NormalizedSignatureEvent | null;

  /** Relance : renvoie l'email d'invitation à un signataire (PUT /submitters/{id}). */
  remindSubmitter(providerSubmitterId: string): Promise<void>;

  /** Révocation : archive la submission chez le provider (DELETE /submissions/{id}). */
  revokeSubmission(providerSubmissionId: string): Promise<void>;
}
