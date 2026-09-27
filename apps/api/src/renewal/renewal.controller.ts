import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { readMultipart } from '../common/http-io.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { RenewalService } from './renewal.service.js';

const ReasonSchema = z.object({ reason: z.string().trim().min(1, 'Un motif est obligatoire.').max(2000) }).strict();
const RenewSchema = z.object({ months: z.number().int().min(1).max(120).optional() }).strict();
const PreviewSchema = z.object({ requestedDate: z.iso.date().optional() }).strict();

/** Reconduction, renouvellement et résiliation — décisions humaines (lot 5). */
@Controller('v1/contracts')
export class RenewalController {
  constructor(private readonly renewal: RenewalService) {}

  @Get(':id/termination-preview')
  preview(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(PreviewSchema)) q: z.infer<typeof PreviewSchema>,
  ) {
    assertCan(s, 'contracts.read');
    return this.renewal.terminationPreview(scope, id, q.requestedDate ? new Date(q.requestedDate) : null, new Date());
  }

  @Post(':id/renewal/renew')
  renew(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RenewSchema)) b: z.infer<typeof RenewSchema>,
  ) {
    assertCan(s, 'contracts.lifecycle');
    return this.renewal.renewPeriod(scope, id, b.months, s.userId, new Date());
  }

  @Post(':id/renewal/close')
  close(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>,
  ) {
    assertCan(s, 'contracts.lifecycle');
    return this.renewal.closeRenewal(scope, id, b.reason, s.userId, new Date());
  }

  @Post(':id/withdraw-termination')
  withdraw(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>,
  ) {
    assertCan(s, 'contracts.lifecycle');
    return this.renewal.withdrawTermination(scope, id, b.reason, s.userId, new Date());
  }

  /** Multipart `letter` (PDF). */
  @Post(':id/termination-letter')
  async letter(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Req() req: FastifyRequest,
  ) {
    assertCan(s, 'contracts.lifecycle');
    const { file } = await readMultipart(req, 'letter');
    if (!file) throw new BadRequestException('Courrier manquant.');
    return this.renewal.attachTerminationLetter(scope, id, file, s.userId, new Date());
  }
}
