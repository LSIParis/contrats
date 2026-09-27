import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ProviderAuthError,
  ProviderError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderValidationError,
  planSigningOrder,
  resolveSigningPolicy,
  type CompletedDocuments,
  type CreateSubmissionCommand,
  type CreateTemplateSubmissionCommand,
  type ESignatureProvider,
  type NormalizedSignatureEvent,
  type ProviderReadiness,
  type ProviderSubmission,
  type ProviderSubmissionState,
  type ProviderSubmissionStatus,
  type ProviderSubmitterStatus,
  type SignatureEventKind,
  type SignedDocuments,
  type SubmitterCommand,
  type WebhookVerification,
} from '@lsi/domain';

/**
 * Adaptateur DocuSeal Pro (auto-hébergé). (§11.1, 06-docuseal.md)
 *
 * LE SEUL fichier qui connaît le format DocuSeal. Tout le reste de
 * l'application parle le vocabulaire du port.
 *
 * Contrat d'API vérifié le 2026-09-26 contre la spécification publique
 * (https://www.docuseal.com/docs/api, OpenAPI console.docuseal.com/openapi.json) :
 *   - authentification : en-tête `X-Auth-Token` ;
 *   - POST /submissions/pdf (Pro) → OBJET `{id, submitters:[…]}` ;
 *   - POST /submissions (modèle)  → TABLEAU de submitters (`submission_id`) ;
 *   - GET  /submissions/{id}      → `status`, `audit_log_url`,
 *     `combined_document_url`, `documents[]`, `submitters[]` ;
 *   - GET  /submissions/{id}/documents?merge=true → `{id, documents:[{name,url}]}` ;
 *   - GET  /submitters?external_id=… → filtre par external_id de SIGNATAIRE
 *     (GET /submissions n'a PAS de filtre external_id).
 *
 * Configuration (variables d'environnement, lues à l'usage) :
 *   DOCUSEAL_URL                    base de l'API, ex. https://signe.example.fr/api
 *   DOCUSEAL_API_KEY                jeton X-Auth-Token
 *   DOCUSEAL_TIMEOUT_MS             délai des appels (défaut 30 000)
 *   DOCUSEAL_READINESS_TIMEOUT_MS   délai de la sonde (défaut 5 000)
 *   DOCUSEAL_WEBHOOK_SECRET         secret HMAC des webhooks (obligatoire)
 *   DOCUSEAL_SIGNATURE_HEADER       en-tête HMAC (défaut x-docuseal-signature)
 *   DOCUSEAL_WEBHOOK_HEADER_SECRET  secret partagé ADDITIONNEL (optionnel)
 *   DOCUSEAL_WEBHOOK_HEADER_NAME    son en-tête (défaut x-docuseal-webhook-secret)
 */

/** DocuSeal → nous. Traduction, pas passage. */
const EVENT_MAP: Record<string, SignatureEventKind> = {
  'form.viewed': 'FORM_VIEWED',
  'form.started': 'FORM_STARTED',
  'form.completed': 'FORM_COMPLETED',
  'form.declined': 'FORM_DECLINED',
  'submission.completed': 'SUBMISSION_COMPLETED',
  'submission.expired': 'SUBMISSION_EXPIRED',
};

const SUBMISSION_STATUS: Record<string, ProviderSubmissionStatus> = {
  pending: 'PENDING',
  completed: 'COMPLETED',
  declined: 'DECLINED',
  expired: 'EXPIRED',
};

const SUBMITTER_STATUS: Record<string, ProviderSubmitterStatus> = {
  awaiting: 'AWAITING',
  sent: 'SENT',
  opened: 'OPENED',
  completed: 'COMPLETED',
  declined: 'DECLINED',
};

/**
 * R6 — LEVÉ le 2026-07-17.
 *
 * Vérifié dans la source DocuSeal (lib/webhook_urls/signatures.rb et
 * lib/send_webhook_request.rb) : l'en-tête est `X-Docuseal-Signature`.
 *
 * Confirmé IDENTIQUE sur l'instance de production (signe.lsi-maintenance.fr,
 * image ds-ee) : même fichier, même format `<timestamp>.<hmac>`, même
 * tolérance ±5 min. Aucune divergence Pro/OSS.
 */
const signatureHeader = (): string =>
  (process.env.DOCUSEAL_SIGNATURE_HEADER ?? 'x-docuseal-signature').toLowerCase();

const sharedSecretHeader = (): string =>
  (process.env.DOCUSEAL_WEBHOOK_HEADER_NAME ?? 'x-docuseal-webhook-secret').toLowerCase();

/**
 * Tolérance d'horodatage, en secondes.
 *
 * DocuSeal utilise 5 minutes (TOLERANCE = 5 * 60). On aligne : plus strict
 * rejetterait des webhooks légitimes en cas de dérive d'horloge, plus laxiste
 * élargirait la fenêtre de rejeu.
 */
const TIMESTAMP_TOLERANCE_S = 5 * 60;

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Comparaison à temps constant de deux chaînes (longueurs publiques). */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly timeoutMs?: number;
  /** Libellé de l'opération pour les messages d'erreur. */
  readonly what: string;
}

@Injectable()
export class DocusealAdapter implements ESignatureProvider {
  readonly name = 'DOCUSEAL' as const;

  private get secret(): string {
    const s = process.env.DOCUSEAL_WEBHOOK_SECRET;
    if (!s) {
      // Fail closed. Un secret absent ne doit JAMAIS faire passer la
      // vérification : sans cela, oublier la variable d'environnement en
      // production ouvrirait le webhook au monde entier, en silence.
      throw new Error('DOCUSEAL_WEBHOOK_SECRET absent : le webhook ne peut pas être vérifié');
    }
    return s;
  }

  private get baseUrl(): string {
    // Auto-hébergé : l'instance vit sur un VPS dédié. Sans barre finale.
    return (process.env.DOCUSEAL_URL ?? 'http://docuseal:3000/api').replace(/\/+$/, '');
  }

  private get apiKey(): string {
    const k = process.env.DOCUSEAL_API_KEY;
    if (!k) throw new ProviderAuthError('DOCUSEAL_API_KEY absent', null);
    return k;
  }

  private get timeoutMs(): number {
    return positiveInt(process.env.DOCUSEAL_TIMEOUT_MS, 30_000);
  }

  // ===========================================================================
  // Transport — UN SEUL endroit traduit HTTP en erreurs typées.
  // ===========================================================================

  /**
   * Appel authentifié à l'API, réponse JSON.
   *
   *   pas de réponse dans le délai → ProviderTimeoutError (réessayable, mais
   *                                  APRÈS vérification : §11.8)
   *   réseau                       → ProviderUnavailableError
   *   401/403                      → ProviderAuthError
   *   400/422                      → ProviderValidationError (message DocuSeal)
   *   404                          → ProviderError NOT_FOUND
   *   429/5xx                      → ProviderUnavailableError
   */
  private async call(path: string, opts: CallOptions): Promise<unknown> {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: {
        'X-Auth-Token': this.apiKey,
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw this.transportError(opts.what, e);
    }

    if (!res.ok) throw await this.httpError(opts.what, res);

    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError(`DocuSeal ${opts.what} : réponse non JSON`, false, 'PROTOCOL', res.status);
    }
  }

  private transportError(what: string, e: unknown): ProviderError {
    const name = (e as { name?: string } | null)?.name;
    const message = (e as Error | null)?.message ?? String(e);
    if (name === 'TimeoutError' || name === 'AbortError') {
      // La requête est peut-être arrivée : ne JAMAIS en conclure qu'elle a
      // échoué. Le réessai passe par findSubmissionByExternalId (§11.8).
      return new ProviderTimeoutError(`DocuSeal ${what} : délai dépassé`);
    }
    return new ProviderUnavailableError(`DocuSeal ${what} injoignable : ${message}`, null);
  }

  private async httpError(what: string, res: Response): Promise<ProviderError> {
    const raw = await res.text().catch(() => '');
    // DocuSeal répond `{"error": "..."}`. On n'en garde qu'un extrait : un
    // corps d'erreur peut refléter notre payload, donc des données client.
    let providerMessage = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed?.error === 'string') providerMessage = parsed.error.slice(0, 300);
    } catch {
      /* corps non JSON : extrait brut */
    }
    const msg = `DocuSeal ${what} : HTTP ${res.status}${providerMessage ? ` — ${providerMessage}` : ''}`;

    if (res.status === 401 || res.status === 403) return new ProviderAuthError(msg, res.status);
    if (res.status === 400 || res.status === 422) return new ProviderValidationError(msg, res.status, providerMessage);
    if (res.status === 404) return new ProviderError(msg, false, 'NOT_FOUND', res.status);
    if (res.status === 429 || res.status >= 500) return new ProviderUnavailableError(msg, res.status);
    return new ProviderError(msg, false, 'PROTOCOL', res.status);
  }

  /**
   * Télécharge un fichier servi par DocuSeal (URL signée).
   *
   * SANS le jeton : ces URLs sont autoportantes, et envoyer X-Auth-Token à
   * une URL reçue du réseau le ferait fuiter vers n'importe quel hôte.
   * On exige un PDF (`%PDF-`) : une page d'erreur HTML stockée comme
   * « document signé » serait une preuve corrompue et silencieuse.
   */
  private async fetchPdf(url: string, what: string): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ProviderError(`DocuSeal ${what} : URL invalide`, false, 'PROTOCOL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ProviderError(`DocuSeal ${what} : schéma refusé (${parsed.protocol})`, false, 'PROTOCOL');
    }

    let res: Response;
    try {
      res = await fetch(parsed, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    } catch (e) {
      throw this.transportError(what, e);
    }
    if (!res.ok) throw await this.httpError(what, res);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new ProviderError(`DocuSeal ${what} : le fichier reçu n'est pas un PDF`, false, 'PROTOCOL', res.status);
    }
    return buf;
  }

  // ===========================================================================
  // Création
  // ===========================================================================

  /**
   * VOIE NOMINALE — POST /submissions/pdf (Pro) : on envoie LE PDF figé.
   *
   * Pourquoi pas un template DocuSeal par contrat ? Parce que chaque contrat
   * est unique : on polluerait DocuSeal de milliers d'objets à usage unique.
   * Les champs sont posés par balises textuelles dans le PDF (text-tags.ts).
   */
  async createSubmission(cmd: CreateSubmissionCommand): Promise<ProviderSubmission> {
    // Le PDF envoyé DOIT être celui dont l'empreinte est stockée (§11.2).
    // Un écart ici — buffer réutilisé, re-rendu intempestif — ruinerait la
    // valeur probante sans que personne ne s'en aperçoive.
    if (cmd.pdfSha256 !== undefined && sha256(cmd.pdf) !== cmd.pdfSha256.toLowerCase()) {
      throw new ProviderError(
        'Le PDF à envoyer ne correspond pas à l’empreinte stockée de la version',
        false,
        'VALIDATION',
      );
    }

    const plan = planSigningOrder(cmd.submitters, resolveSigningPolicy(cmd));
    const payload = {
      name: cmd.documentName,
      documents: [{ name: cmd.documentName, file: cmd.pdf.toString('base64') }],
      ...this.commonPayload(cmd, plan.order),
      submitters: plan.submitters.map((s) => this.submitterPayload(s, cmd.metadata)),
    };

    // POST /submissions/pdf renvoie un OBJET {id, submitters:[...]}, alors que
    // POST /submissions (par template) renvoie un TABLEAU de submitters.
    // Forme confirmée contre l'instance réelle (2026-07-17) et l'OpenAPI.
    const body = (await this.call('/submissions/pdf', { method: 'POST', body: payload, what: 'création (PDF)' })) as any;
    const submissionId = body?.id ?? body?.submitters?.[0]?.submission_id;
    if (submissionId === undefined || submissionId === null) {
      throw new ProviderError('Réponse DocuSeal sans identifiant de submission', false, 'PROTOCOL');
    }
    return this.toProviderSubmission(submissionId, Array.isArray(body?.submitters) ? body.submitters : []);
  }

  /**
   * VOIE SECONDAIRE — POST /submissions depuis un modèle figé chez DocuSeal.
   *
   * Réservée aux documents standard récurrents. Le pré-remplissage passe par
   * `fields[].default_value` + `readonly: true` (voir SubmitterField).
   */
  async createSubmissionFromTemplate(cmd: CreateTemplateSubmissionCommand): Promise<ProviderSubmission> {
    const templateId = Number(cmd.providerTemplateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      throw new ProviderError(`Identifiant de modèle DocuSeal invalide : ${cmd.providerTemplateId}`, false, 'VALIDATION');
    }
    const plan = planSigningOrder(cmd.submitters, resolveSigningPolicy(cmd));
    const payload = {
      template_id: templateId,
      ...this.commonPayload(cmd, plan.order),
      submitters: plan.submitters.map((s) => this.submitterPayload(s, cmd.metadata)),
    };

    const body = (await this.call('/submissions', { method: 'POST', body: payload, what: 'création (modèle)' })) as any;
    const subs: any[] = Array.isArray(body) ? body : Array.isArray(body?.submitters) ? body.submitters : [];
    const submissionId = subs[0]?.submission_id ?? body?.id;
    if (submissionId === undefined || submissionId === null) {
      throw new ProviderError('Réponse DocuSeal sans identifiant de submission', false, 'PROTOCOL');
    }
    return this.toProviderSubmission(submissionId, subs);
  }

  private commonPayload(
    cmd: CreateSubmissionCommand | CreateTemplateSubmissionCommand,
    order: 'preserved' | 'random',
  ) {
    // Signature intégrée : AUCUN e-mail DocuSeal, le lien est servi par
    // l'application (embed_src). Sinon, défaut = envoi actif.
    const sendEmail = cmd.delivery === 'EMBEDDED' ? false : (cmd.sendEmail ?? true);
    return {
      send_email: sendEmail,
      order,
      expire_at: this.formatExpiry(cmd.expireAt),
      completed_redirect_url: cmd.completedRedirectUrl,
      message: { subject: cmd.subject, body: cmd.body },
    };
  }

  private submitterPayload(s: SubmitterCommand, metadata: Record<string, string>) {
    return {
      // Le rôle vient du domaine (roleLabel), pas d'un mapping local : il
      // doit être IDENTIQUE à celui des balises {{…;role=…}} du document,
      // sinon le signataire n'a aucun champ à signer (§11.3).
      role: s.roleLabel,
      name: s.fullName,
      email: s.email,
      order: s.signingOrder,
      external_id: s.externalId,
      require_email_2fa: s.requireEmail2fa,
      metadata,
      fields: s.fields.map((f) => ({
        name: f.name,
        default_value: f.defaultValue,
        // DocuSeal n'applique l'immuabilité que si readonly est posé
        // CÔTÉ SERVEUR. default_value seul se modifie depuis les devtools.
        readonly: f.readonly,
      })),
    };
  }

  private toProviderSubmission(submissionId: unknown, subs: any[]): ProviderSubmission {
    return {
      providerSubmissionId: String(submissionId),
      submitters: subs.map((s) => ({
        externalId: s.external_id ?? null,
        providerSubmitterId: String(s.id),
        slug: s.slug,
        embedSrc: typeof s.embed_src === 'string' ? s.embed_src : null,
      })),
    };
  }

  // ===========================================================================
  // Lecture
  // ===========================================================================

  /**
   * Filet anti-double-envoi après timeout (§11.8).
   *
   * GET /submitters?external_id=… — c'est LÀ que DocuSeal filtre par
   * external_id (celui d'un signataire). L'implémentation précédente
   * interrogeait GET /submissions?external_id=…, paramètre que l'API ne
   * documente pas : ignoré, il renvoyait la DERNIÈRE submission du compte,
   * quelle qu'elle soit — un faux positif qui aurait fait croire à l'envoi.
   *
   * Une erreur (auth, 5xx) LÈVE au lieu de renvoyer null : « je ne sais
   * pas » ne doit jamais être lu comme « elle n'existe pas », sinon on
   * renvoie une seconde invitation.
   */
  async findSubmissionByExternalId(externalId: string): Promise<ProviderSubmission | null> {
    const list = (await this.call(`/submitters?external_id=${encodeURIComponent(externalId)}&limit=1`, {
      what: 'recherche par external_id',
      timeoutMs: 15_000,
    })) as any;
    const found = list?.data?.[0];
    if (!found || found.external_id !== externalId) return null;

    const submission = (await this.call(`/submissions/${encodeURIComponent(String(found.submission_id))}`, {
      what: 'lecture submission',
      timeoutMs: 15_000,
    })) as any;
    return this.toProviderSubmission(submission?.id ?? found.submission_id, submission?.submitters ?? []);
  }

  /** GET /submissions/{id} — état normalisé, pour la réconciliation (EC-06). */
  async getSubmission(providerSubmissionId: string): Promise<ProviderSubmissionState> {
    const body = await this.readSubmission(providerSubmissionId);
    const status = SUBMISSION_STATUS[String(body?.status)];
    if (!status) {
      throw new ProviderError(`Statut de submission DocuSeal inconnu : ${String(body?.status)}`, false, 'PROTOCOL');
    }
    const subs: any[] = Array.isArray(body?.submitters) ? body.submitters : [];
    return {
      providerSubmissionId: String(body.id ?? providerSubmissionId),
      status,
      completedAt: toDate(body.completed_at),
      expireAt: toDate(body.expire_at),
      submitters: subs.map((s) => ({
        providerSubmitterId: String(s.id),
        externalId: s.external_id ?? null,
        email: s.email ?? null,
        // Statut inconnu : on retient le plus prudent (invitation envoyée,
        // rien d'acquis) plutôt que de deviner une signature.
        status: SUBMITTER_STATUS[String(s.status)] ?? 'SENT',
        openedAt: toDate(s.opened_at),
        completedAt: toDate(s.completed_at),
        declinedAt: toDate(s.declined_at),
        declineReason: s.decline_reason ?? null,
      })),
    };
  }

  private async readSubmission(providerSubmissionId: string): Promise<any> {
    return this.call(`/submissions/${encodeURIComponent(providerSubmissionId)}`, { what: 'lecture submission' });
  }

  /**
   * Rapatrie les documents d'une submission COMPLÉTÉE. (§11.6)
   *
   *   1. GET /submissions/{id}                   statut + audit_log_url + documents
   *   2. GET /submissions/{id}/documents?merge=true   PDF fusionné
   *   3. téléchargement des octets, contrôle `%PDF-`
   *
   * Les URLs ne sont JAMAIS conservées : seuls les octets le sont (copie
   * locale hachée par l'appelant).
   */
  async downloadCompletedDocuments(providerSubmissionId: string): Promise<CompletedDocuments> {
    const submission = await this.readSubmission(providerSubmissionId);
    if (submission?.status !== 'completed') {
      throw new ProviderError(
        `Submission ${providerSubmissionId} non complétée (statut ${String(submission?.status)})`,
        true,
        'NOT_READY',
      );
    }

    const merged = (await this.call(`/submissions/${encodeURIComponent(providerSubmissionId)}/documents?merge=true`, {
      what: 'documents fusionnés',
    })) as any;
    const mergedUrl: unknown = merged?.documents?.[0]?.url;
    if (typeof mergedUrl !== 'string') {
      throw new ProviderError('DocuSeal documents?merge=true : aucun document', false, 'PROTOCOL');
    }
    const mergedPdf = await this.fetchPdf(mergedUrl, 'document fusionné');

    const docs: any[] = Array.isArray(submission.documents) ? submission.documents : [];
    const documents: { name: string; pdf: Buffer }[] = [];
    for (const d of docs) {
      if (typeof d?.url !== 'string') continue;
      documents.push({ name: String(d.name ?? 'document'), pdf: await this.fetchPdf(d.url, `document ${String(d.name)}`) });
    }

    const auditLogPdf =
      typeof submission.audit_log_url === 'string' ? await this.fetchPdf(submission.audit_log_url, "journal d'audit") : null;
    const combinedPdf =
      typeof submission.combined_document_url === 'string'
        ? await this.fetchPdf(submission.combined_document_url, 'document combiné')
        : null;

    return { mergedPdf, auditLogPdf, combinedPdf, documents };
  }

  /** @deprecated Voir downloadCompletedDocuments. */
  async downloadSignedDocuments(providerSubmissionId: string): Promise<SignedDocuments> {
    const d = await this.downloadCompletedDocuments(providerSubmissionId);
    return { signedPdf: d.mergedPdf, auditTrail: d.auditLogPdf };
  }

  /**
   * Sonde : GET /templates?limit=1.
   *
   * L'API publique n'a pas d'endpoint de santé ni de « whoami » documenté
   * (vérifié 2026-09-26). GET /templates est le plus léger des appels
   * AUTHENTIFIÉS disponibles sur toutes les éditions : il distingue
   * « injoignable » (réseau, délai) de « jeton refusé » (401).
   * Ne lève jamais.
   */
  async checkReadiness(): Promise<ProviderReadiness> {
    if (!process.env.DOCUSEAL_API_KEY) {
      return { reachable: false, tokenValid: false, detail: 'DOCUSEAL_API_KEY absent : DocuSeal non configuré' };
    }
    try {
      await this.call('/templates?limit=1', {
        what: 'sonde',
        timeoutMs: positiveInt(process.env.DOCUSEAL_READINESS_TIMEOUT_MS, 5_000),
      });
      return { reachable: true, tokenValid: true, detail: 'ok' };
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.code === 'AUTH') return { reachable: true, tokenValid: false, detail: `jeton refusé (HTTP ${e.httpStatus ?? '?'})` };
        if (e.code === 'TIMEOUT' || e.httpStatus === null) return { reachable: false, tokenValid: false, detail: e.message };
        return { reachable: true, tokenValid: false, detail: e.message };
      }
      return { reachable: false, tokenValid: false, detail: (e as Error).message };
    }
  }

  // ===========================================================================
  // Actions
  // ===========================================================================

  async remindSubmitter(providerSubmitterId: string): Promise<void> {
    await this.call(`/submitters/${encodeURIComponent(providerSubmitterId)}`, {
      method: 'PUT',
      body: { send_email: true },
      what: 'relance',
      timeoutMs: 15_000,
    });
  }

  async revokeSubmission(providerSubmissionId: string): Promise<void> {
    await this.call(`/submissions/${encodeURIComponent(providerSubmissionId)}`, {
      method: 'DELETE',
      what: 'révocation',
      timeoutMs: 15_000,
    });
  }

  /** DocuSeal attend « 2024-09-01 12:00:00 UTC », pas de l'ISO 8601. */
  private formatExpiry(d: Date): string {
    return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }

  // ===========================================================================
  // Webhooks
  // ===========================================================================

  /**
   * Vérifie l'authenticité d'un webhook DocuSeal.
   *
   * 1. HMAC — OBLIGATOIRE. Format relevé dans la source de l'instance
   *    (lib/webhook_urls/signatures.rb) :
   *
   *      en-tête  : "<timestamp>.<hexdigest>"
   *      digest   : HMAC_SHA256(secret, "<timestamp>.<body>")
   *      tolérance: ±5 minutes
   *
   *    ⚠ La première implémentation signait le CORPS SEUL et attendait un
   *    digest nu. Elle aurait rejeté TOUS les webhooks DocuSeal réels — et
   *    ses 15 tests passaient, parce qu'ils validaient ce format inventé
   *    contre lui-même.
   *
   * 2. Secret partagé — OPTIONNEL, en plus. Si DOCUSEAL_WEBHOOK_HEADER_SECRET
   *    est défini, l'en-tête DOCUSEAL_WEBHOOK_HEADER_NAME doit le porter
   *    (en-tête personnalisé configuré sur le webhook DocuSeal). Défense en
   *    profondeur : une fuite du seul secret HMAC ne suffit plus.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerification {
    const hmac = this.verifyHmac(rawBody, headers);
    if (!hmac.valid) return hmac;

    const expectedShared = process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET;
    if (expectedShared) {
      const raw = headers[sharedSecretHeader()];
      const received = Array.isArray(raw) ? raw[0] : raw;
      if (!received) return { valid: false, reason: 'secret partagé absent' };
      if (!safeEqual(received, expectedShared)) return { valid: false, reason: 'secret partagé invalide' };
    }
    return { valid: true };
  }

  private verifyHmac(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerification {
    const raw = headers[signatureHeader()];
    const received = Array.isArray(raw) ? raw[0] : raw;
    if (!received) return { valid: false, reason: 'signature absente' };

    // `split('.', 2)` façon Ruby : on découpe sur le PREMIER séparateur pour
    // rester fidèle à l'émetteur.
    const dot = received.indexOf('.');
    if (dot < 1) return { valid: false, reason: 'signature malformée' };

    const tsPart = received.slice(0, dot);
    const sig = received.slice(dot + 1);
    if (!/^\d+$/.test(tsPart) || !sig) return { valid: false, reason: 'signature malformée' };

    const ts = Number(tsPart);
    const now = Math.floor(Date.now() / 1000);

    // Anti-rejeu. Une signature valide capturée reste valide éternellement
    // sans cette borne.
    if (ts < now - TIMESTAMP_TOLERANCE_S) return { valid: false, reason: 'horodatage trop ancien' };
    if (ts > now + TIMESTAMP_TOLERANCE_S) return { valid: false, reason: 'horodatage dans le futur' };

    // Le message signé est "<timestamp>.<body>", pas le corps seul : c'est
    // ce qui lie la signature à son instant.
    const signedPayload = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), rawBody]);
    const expected = createHmac('sha256', this.secret).update(signedPayload).digest('hex');

    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Longueurs différentes → timingSafeEqual lève. La longueur attendue est
    // publique (hex de sha256) : sortir tôt ne révèle rien.
    if (a.length !== b.length) return { valid: false, reason: 'signature malformée' };

    // Temps constant : un === fuit la position du premier octet divergent.
    if (!timingSafeEqual(a, b)) return { valid: false, reason: 'signature invalide' };

    return { valid: true };
  }

  /**
   * Payload DocuSeal → événement normalisé.
   *
   * Deux formes (OpenAPI, section webhooks) :
   *   form.*        data = le SUBMITTER ; `data.submission_id` (+ `data.submission.id`)
   *   submission.*  data = la SUBMISSION ; `data.id` est l'id de submission
   */
  parseWebhook(payload: unknown): NormalizedSignatureEvent | null {
    const p = payload as any;
    const kind = EVENT_MAP[p?.event_type];
    if (!kind) return null;

    const data = p.data ?? {};
    const isSubmissionEvent = kind === 'SUBMISSION_COMPLETED' || kind === 'SUBMISSION_EXPIRED';
    const submissionId = isSubmissionEvent ? data.id : (data.submission_id ?? data.submission?.id ?? data.id);
    if (submissionId === undefined || submissionId === null) return null;

    const occurred = new Date(p.timestamp ?? Date.now());

    return {
      eventId: this.buildEventId(p),
      kind,
      // Un horodatage illisible ne doit pas faire échouer l'insertion : on
      // retient l'heure de réception, le payload brut garde l'original.
      occurredAt: Number.isNaN(occurred.getTime()) ? new Date() : occurred,
      providerSubmissionId: String(submissionId),
      providerSubmitterId: isSubmissionEvent ? '' : String(data.id ?? ''),
      externalSignerId: isSubmissionEvent ? null : (data.external_id ?? null),
      submitterEmail: isSubmissionEvent ? null : (data.email ?? null),
      declineReason: data.decline_reason ?? null,
      ip: data.ip ?? null,
      userAgent: data.ua ?? null,
      // Portée au diagnostic uniquement. JAMAIS à l'autorisation (§11.4).
      untrustedMetadata: data.metadata ?? {},
      rawPayload: payload,
    };
  }

  /**
   * Identifiant d'événement déterministe, support de l'idempotence (EC-05).
   *
   * DocuSeal ne fournit pas d'identifiant d'événement. On le dérive donc de
   * (type, submission, submitter, horodatage) : un réessai du MÊME événement
   * porte les mêmes valeurs, donc la même clé, et la contrainte UNIQUE en
   * base le rejette. Formule INCHANGÉE depuis l'origine : la modifier ferait
   * accepter une seconde fois des événements déjà journalisés.
   *
   * Limite assumée : deux événements distincts de même type, même submitter
   * et même horodatage à la seconde seraient confondus — physiquement
   * improbable pour un parcours de signature humain.
   */
  private buildEventId(p: any): string {
    const d = p.data ?? {};
    const sub = d.submission?.id ?? d.id ?? 'x';
    return `docuseal:${p.event_type}:${sub}:${d.id ?? 'x'}:${p.timestamp ?? 'x'}`;
  }
}

function toDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
