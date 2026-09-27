import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ContractsService } from '../contracts/contracts.service.js';
import { AcceptanceService, RecordAcceptanceSchema } from './acceptance.service.js';

const Reason = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();

/**
 * Présentation au client, négociation, acceptation (02-cycle-de-vie §2-§4).
 * Le domaine tranche (gardes RM-11, V2-ACC, V2-NEG) ; ces routes ne font que
 * traduire l'intention en événement.
 */
@Controller('v1/contracts')
export class NegotiationController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly acceptance: AcceptanceService,
  ) {}

  /** APPROVED / IN_NEGOTIATION → SENT_TO_CLIENT (version validée uniquement). */
  @Post(':id/send-to-client')
  sendToClient(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.negotiate');
    return this.contracts.applyEvent(scope, id, { type: 'SEND_TO_CLIENT', actorUserId: s.userId }, new Date());
  }

  /** SENT_TO_CLIENT / ACCEPTED → IN_NEGOTIATION (demande de modification du client). */
  @Post(':id/negotiate')
  negotiate(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>,
  ) {
    assertCan(s, 'contracts.negotiate');
    return this.contracts.applyEvent(scope, id, { type: 'OPEN_NEGOTIATION', actorUserId: s.userId, reason: body.reason }, new Date());
  }

  /** DECLINED / SIGNATURE_EXPIRED → IN_NEGOTIATION. */
  @Post(':id/reopen-negotiation')
  reopen(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>,
  ) {
    assertCan(s, 'contracts.negotiate');
    return this.contracts.applyEvent(scope, id, { type: 'REOPEN_NEGOTIATION', actorUserId: s.userId, reason: body.reason }, new Date());
  }

  /** Acceptation reçue hors application, enregistrée par LSI (pièce justificative obligatoire). */
  @Post(':id/acceptance')
  record(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RecordAcceptanceSchema)) body: z.infer<typeof RecordAcceptanceSchema>,
  ) {
    assertCan(s, 'contracts.negotiate');
    return this.acceptance.accept(scope, id, {
      method: 'RECORDED_BY_STAFF', versionId: body.versionId, name: body.acceptedByName, email: body.acceptedByEmail,
      userId: s.userId, ip: null, userAgent: null, evidenceNote: body.evidenceNote,
    }, new Date());
  }

  @Get(':id/acceptances')
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.read');
    return this.acceptance.list(scope, id);
  }
}
