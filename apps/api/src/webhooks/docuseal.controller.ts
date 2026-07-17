import { Controller, Post, Headers, HttpCode, Req, BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.js';
import { DocusealWebhookService } from './docuseal-webhook.service.js';

/**
 * Webhook DocuSeal. (§11.4)
 *
 * @Public() : un webhook arrive SANS session. C'est le seul endpoint de
 * l'application où le scope ne peut pas venir d'un cookie — et donc celui où
 * se joue la sécurité de toute l'intégration.
 *
 * La compensation n'est pas « moins de contrôle » mais « un autre contrôle » :
 * HMAC sur le corps brut à l'entrée, et scope résolu depuis notre propre base.
 */
@Controller('v1/webhooks')
export class DocusealWebhookController {
  constructor(private readonly service: DocusealWebhookService) {}

  @Public()
  @Post('docuseal')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    // Le CORPS BRUT, pas le JSON reparsé. Un HMAC calculé sur
    // JSON.stringify(JSON.parse(body)) serait faux dès que l'émetteur
    // ordonne ses clés ou espace autrement — et « ça marche chez moi »
    // deviendrait « ça échoue en production ».
    const raw = req.rawBody;
    if (!raw) throw new BadRequestException('Corps brut indisponible');

    // 200 sur les erreurs métier définitives, 5xx uniquement sur le
    // transitoire : DocuSeal réessaie 48 h en backoff sur les 4xx/5xx.
    return this.service.handle(raw, headers);
  }
}
