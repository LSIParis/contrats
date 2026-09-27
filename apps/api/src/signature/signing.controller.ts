import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { SignatureAvailabilityService } from './signature-availability.service.js';

/**
 * Signature INTÉGRÉE (brief §7 : `embed_src` / composant web DocuSeal).
 *
 * Renvoie l'URL de signature du signataire QUI EST la personne connectée
 * (rapprochement par e-mail de la session, insensible à la casse) — jamais
 * celle d'un autre signataire. L'URL n'est pas stockée : elle se reconstruit
 * depuis le `slug` DocuSeal, comme le lien du portail.
 */
@Controller('v1')
export class SigningController {
  constructor(private readonly availability: SignatureAvailabilityService) {}

  /** Signature de LSI-Maintenance par le signataire interne connecté. */
  @Get('contracts/:id/signing')
  async internal(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.signInternal');
    return this.embed(scope, id, 'LSI');
  }

  /** Signature du client, depuis le portail. */
  @Get('portal/contracts/:id/signing')
  async portal(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'portal.sign');
    return this.embed(scope, id, 'CLIENT');
  }

  /** Disponibilité effective, pour que l'interface masque ou explique la signature. */
  @Get('signature/availability')
  availabilityOf(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'contracts.read');
    return this.availability.get(scope);
  }

  private async embed(scope: Scope, contractId: string, party: 'LSI' | 'CLIENT') {
    await this.availability.assertEnabled(scope);
    return withScope(scope, async (tx) => {
      const me = await tx.user.findUnique({ where: { id: scope.userId }, select: { email: true } });
      if (!me) throw new ForbiddenException('Utilisateur inconnu');
      const signer = await tx.contractSigner.findFirst({
        where: { contractId, party, email: { equals: me.email, mode: 'insensitive' } },
        select: { status: true, providerSubmitterSlug: true },
      });
      if (!signer?.providerSubmitterSlug) throw new NotFoundException('Aucune signature en attente pour vous sur ce contrat');
      if (signer.status === 'SIGNED') return { alreadySigned: true, embedSrc: null };
      const base = process.env.DOCUSEAL_SIGN_URL ?? (process.env.DOCUSEAL_URL ?? '').replace(/\/api\/?$/, '');
      return { alreadySigned: false, embedSrc: `${base}/s/${signer.providerSubmitterSlug}` };
    });
  }
}
