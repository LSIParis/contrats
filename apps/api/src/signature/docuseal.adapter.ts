import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ProviderError,
  type CreateSubmissionCommand,
  type ESignatureProvider,
  type NormalizedSignatureEvent,
  type ProviderSubmission,
  type SignatureEventKind,
  type WebhookVerification,
} from '@lsi/domain';

/**
 * Adaptateur DocuSeal. (§11.1)
 *
 * LE SEUL fichier qui connaît le format DocuSeal. Tout le reste de
 * l'application parle le vocabulaire du port.
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

/**
 * ⚠ R6 — nom d'en-tête À CONFIRMER au déploiement.
 *
 * La documentation DocuSeal consultée impose la vérification HMAC sans
 * nommer l'en-tête pour l'instance auto-hébergée. Cette constante est le
 * SEUL endroit à ajuster, et le ticket W-04 prévoit un test d'intégration
 * contre l'instance réelle pour le valider.
 *
 * Signalé plutôt qu'inventé : je préfère une constante fausse et isolée à
 * une certitude fabriquée disséminée dans le code.
 */
const SIGNATURE_HEADER = (process.env.DOCUSEAL_SIGNATURE_HEADER ?? 'x-docuseal-signature').toLowerCase();

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
    // Auto-hébergé (H4) : l'instance vit dans notre VPC, en sous-réseau privé.
    return process.env.DOCUSEAL_URL ?? 'http://docuseal:3000/api';
  }

  private get apiKey(): string {
    const k = process.env.DOCUSEAL_API_KEY;
    if (!k) throw new Error('DOCUSEAL_API_KEY absent');
    return k;
  }

  /**
   * POST /submissions/pdf — on envoie LE PDF, pas un template.
   *
   * Pourquoi pas un template DocuSeal par contrat ? Parce que chaque contrat
   * est unique : on polluerait DocuSeal de milliers d'objets à usage unique.
   * Les templates DocuSeal restent réservés aux formulaires réellement
   * récurrents.
   */
  async createSubmission(cmd: CreateSubmissionCommand): Promise<ProviderSubmission> {
    const payload = {
      name: cmd.documentName,
      documents: [{ name: cmd.documentName, file: cmd.pdf.toString('base64') }],
      send_email: true,
      order: cmd.order,
      expire_at: this.formatExpiry(cmd.expireAt),
      completed_redirect_url: cmd.completedRedirectUrl,
      message: { subject: cmd.subject, body: cmd.body },
      submitters: cmd.submitters.map((s) => ({
        role: s.party === 'LSI' ? 'LSI Maintenance' : 'Client',
        name: s.fullName,
        email: s.email,
        order: s.signingOrder,
        external_id: s.externalId,
        require_email_2fa: s.requireEmail2fa,
        metadata: cmd.metadata,
        fields: s.fields.map((f) => ({
          name: f.name,
          default_value: f.defaultValue,
          // DocuSeal n'applique l'immuabilité que si readonly est posé
          // CÔTÉ SERVEUR. default_value seul se modifie depuis les devtools.
          readonly: f.readonly,
        })),
      })),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/submissions/pdf`, {
        method: 'POST',
        headers: { 'X-Auth-Token': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // Réseau ou timeout : réessayable. MAIS le réessai doit d'abord
      // vérifier via findSubmissionByExternalId si la submission a été créée
      // malgré l'absence de réponse (§11.8).
      throw new ProviderError(`DocuSeal injoignable : ${(e as Error).message}`, true);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 4xx = notre payload est fautif : réessayer ne changerait rien.
      // 5xx = leur problème : réessayable.
      throw new ProviderError(`DocuSeal a répondu ${res.status} : ${body.slice(0, 300)}`, res.status >= 500);
    }

    const submitters = (await res.json()) as any[];
    const submissionId = submitters[0]?.submission_id;
    if (submissionId === undefined) {
      throw new ProviderError('Réponse DocuSeal sans submission_id', false);
    }

    return {
      providerSubmissionId: String(submissionId),
      submitters: submitters.map((s) => ({
        externalId: s.external_id ?? null,
        providerSubmitterId: String(s.id),
        slug: s.slug,
      })),
    };
  }

  /**
   * Filet anti-double-envoi après timeout (§11.8).
   *
   * Sans cette vérification avant réessai, un timeout réseau se traduit par
   * DEUX invitations à signer envoyées au client — et deux submissions à
   * réconcilier.
   */
  async findSubmissionByExternalId(externalId: string): Promise<ProviderSubmission | null> {
    const res = await fetch(
      `${this.baseUrl}/submissions?external_id=${encodeURIComponent(externalId)}&limit=1`,
      { headers: { 'X-Auth-Token': this.apiKey }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;

    const body = (await res.json()) as any;
    const found = body?.data?.[0];
    if (!found) return null;

    return {
      providerSubmissionId: String(found.id),
      submitters: (found.submitters ?? []).map((s: any) => ({
        externalId: s.external_id ?? null,
        providerSubmitterId: String(s.id),
        slug: s.slug,
      })),
    };
  }

  /** DocuSeal attend « 2024-09-01 12:00:00 UTC », pas de l'ISO 8601. */
  private formatExpiry(d: Date): string {
    return `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerification {
    const raw = headers[SIGNATURE_HEADER];
    const received = Array.isArray(raw) ? raw[0] : raw;
    if (!received) return { valid: false, reason: 'signature absente' };

    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');

    const a = Buffer.from(received, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Longueurs différentes → timingSafeEqual lève. On sort avant, mais on
    // ne révèle rien de plus : la longueur attendue est publique (hex sha256).
    if (a.length !== b.length) return { valid: false, reason: 'signature malformée' };

    // Comparaison à temps constant : un === classique fuit la position du
    // premier octet divergent, ce qui permet de reconstruire la signature
    // octet par octet.
    if (!timingSafeEqual(a, b)) return { valid: false, reason: 'signature invalide' };

    return { valid: true };
  }

  parseWebhook(payload: unknown): NormalizedSignatureEvent | null {
    const p = payload as any;
    const kind = EVENT_MAP[p?.event_type];
    if (!kind) return null;

    const data = p.data ?? {};
    const submissionId = data.submission?.id ?? data.id;
    if (submissionId === undefined || submissionId === null) return null;

    return {
      eventId: this.buildEventId(p),
      kind,
      occurredAt: new Date(p.timestamp ?? Date.now()),
      providerSubmissionId: String(submissionId),
      providerSubmitterId: String(data.id ?? ''),
      externalSignerId: data.external_id ?? null,
      submitterEmail: data.email ?? null,
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
   * base le rejette.
   *
   * Limite assumée : deux événements distincts de même type, même submitter
   * et même horodatage à la seconde seraient confondus. Pour un parcours de
   * signature humain, c'est physiquement improbable — un signataire n'ouvre
   * pas deux fois le même formulaire dans la même seconde. On préfère cette
   * limite à un hash du corps brut, qui dédupliquerait moins bien : DocuSeal
   * pourrait réémettre le même événement logique avec un corps légèrement
   * différent, et on le traiterait deux fois.
   */
  private buildEventId(p: any): string {
    const d = p.data ?? {};
    const sub = d.submission?.id ?? d.id ?? 'x';
    return `docuseal:${p.event_type}:${sub}:${d.id ?? 'x'}:${p.timestamp ?? 'x'}`;
  }
}
