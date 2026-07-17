import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ESignatureProvider,
  NormalizedSignatureEvent,
  SignatureEventKind,
  WebhookVerification,
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
