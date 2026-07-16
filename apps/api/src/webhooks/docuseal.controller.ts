import { Controller, Post, Body, Headers, HttpCode } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';

/**
 * Webhook DocuSeal. (§11.4)
 *
 * @Public() : un webhook arrive SANS session. C'est le seul endpoint de
 * l'application où le scope ne peut pas venir d'un cookie — et donc celui
 * où se joue la sécurité de toute l'intégration.
 *
 * LA RÈGLE ABSOLUE : le scope n'est JAMAIS lu dans le payload.
 *
 * Le payload contient bien metadata.tenant_id et metadata.customer_id : c'est
 * un piège. Ces valeurs viennent du réseau. Les utiliser reviendrait à laisser
 * un appelant externe choisir dans quel client écrire.
 *
 * Le scope est RÉSOLU depuis notre base, via la contrainte
 * UNIQUE (provider, provider_submission_id) sur signature_requests : elle
 * mappe de façon déterministe une submission externe vers le couple
 * (tenant, customer) que NOUS avons écrit à la création.
 *
 * Squelette : l'implémentation complète (vérification HMAC sur le corps brut,
 * idempotence par provider_event_id, réconciliation) est le ticket W-04.
 */
@Controller('v1/webhooks')
export class DocusealWebhookController {
  @Public()
  @Post('docuseal')
  @HttpCode(200)
  async handle(@Body() _payload: unknown, @Headers() _headers: Record<string, string>) {
    // TODO(W-04) — dans l'ordre, et l'ordre compte :
    //  1. vérifier le HMAC sur le CORPS BRUT, avant tout parsing
    //  2. idempotence : INSERT signature_events (provider_event_id UNIQUE)
    //  3. résoudre le scope via provider_submission_id — DEPUIS NOTRE BASE
    //  4. si divergence avec metadata du payload → alerte de sécurité
    //  5. withScope(systemScope(...)) puis appliquer l'événement
    //
    // 200 même sur erreur métier définitive (submission inconnue) : DocuSeal
    // réessaie 48 h sur les 4xx/5xx, et faire réessayer un événement
    // définitivement non traitable n'est que du bruit.
    return { status: 'not_implemented' };
  }
}
