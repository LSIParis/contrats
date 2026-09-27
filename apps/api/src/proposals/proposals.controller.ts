import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { systemScope, type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { readMultipart, sendFile } from '../common/http-io.js';
import { ProposalsService } from './proposals.service.js';
import { ProposalSendService } from './proposal-send.service.js';
import { ProposalDocumentsService } from './proposal-documents.service.js';
import { ProposalSignatureService } from './proposal-signature.service.js';
import { ProposalConversionService } from './proposal-conversion.service.js';
import { ProposalNotifier } from './proposal-notifier.service.js';
import {
  CreateProposalSchema,
  ListProposalsSchema,
  OptionalReasonSchema,
  ReactivateSchema,
  ReasonSchema,
  RecipientSchema,
  ReplySchema,
  ResendSchema,
  SelectionSchema,
  UpdateProposalSchema,
  ValidatePriceSchema,
  type CreateProposal,
  type ListProposals,
  type RecipientInput,
  type SelectionBody,
  type UpdateProposal,
} from './proposals.schemas.js';

/**
 * API interne des propositions (brief §12). Transitions en sous-ressources
 * d'action (POST /proposals/:id/send…), jamais un PATCH de statut. Droits :
 * matrice `permissions.ts` (proposals.*) ; « sur quoi » : RLS ; « dans quel
 * état » : machine du domaine.
 */
@Controller('v1/proposals')
export class ProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly sending: ProposalSendService,
    private readonly docs: ProposalDocumentsService,
    private readonly signature: ProposalSignatureService,
    private readonly conversion: ProposalConversionService,
    private readonly notifier: ProposalNotifier,
  ) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query(new ZodPipe(ListProposalsSchema)) q: ListProposals) {
    assertCan(s, 'proposals.read');
    return this.proposals.list(scope, q);
  }

  @Post()
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(CreateProposalSchema)) body: CreateProposal) {
    assertCan(s, 'proposals.write');
    return this.proposals.create(scope, body, new Date());
  }

  /** Notifications temps réel du commercial (SSE) : ses propositions seulement. */
  @Get('stream')
  async stream(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Req() req: FastifyRequest, @Res() res: FastifyReply) {
    assertCan(s, 'proposals.read');
    await this.proposals.assertEnabled(scope);
    res.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.raw.write(': flux des propositions\n\n');
    const unsubscribe = this.notifier.subscribe(scope.tenantId, (m) => {
      if (m.userId === s.userId) res.raw.write(`event: proposal\ndata: ${JSON.stringify(m)}\n\n`);
    });
    const ping = setInterval(() => res.raw.write(': ping\n\n'), 25_000);
    ping.unref();
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  @Get(':id')
  get(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.read');
    return this.proposals.get(scope, id, new Date());
  }

  @Patch(':id')
  update(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateProposalSchema)) body: UpdateProposal) {
    assertCan(s, 'proposals.write');
    return this.proposals.update(scope, id, body, new Date());
  }

  @Put(':id/sections')
  sections(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    assertCan(s, 'proposals.write');
    return this.proposals.putSections(scope, id, body, new Date());
  }

  @Put(':id/pricing')
  pricing(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    assertCan(s, 'proposals.write');
    return this.proposals.putPricing(scope, id, body, new Date());
  }

  @Put(':id/selection')
  selection(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SelectionSchema)) body: SelectionBody) {
    assertCan(s, 'proposals.write');
    return this.proposals.setSelection(scope, id, body, new Date());
  }

  @Post(':id/recipients')
  addRecipient(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RecipientSchema)) body: RecipientInput) {
    assertCan(s, 'proposals.write');
    return this.proposals.addRecipient(scope, id, body, new Date());
  }

  @Delete(':id/recipients/:recipientId')
  removeRecipient(
    @CurrentScope() scope: Scope,
    @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    assertCan(s, 'proposals.write');
    return this.proposals.removeRecipient(scope, id, recipientId, new Date());
  }

  @Get(':id/readiness')
  readiness(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.read');
    return this.proposals.readiness(scope, id, new Date());
  }

  @Post(':id/import-docx')
  async importDocx(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Req() req: FastifyRequest) {
    assertCan(s, 'proposals.write');
    const { file } = await readMultipart(req, 'file');
    if (!file) throw new BadRequestException('Fichier .docx attendu (champ « file »).');
    return this.proposals.importDocx(scope, id, file.buffer, new Date());
  }

  // --- Transitions -----------------------------------------------------------

  @Post(':id/submit-review')
  @HttpCode(200)
  submitReview(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.write');
    return this.proposals.transition(scope, id, { type: 'SUBMIT_FOR_REVIEW', actorUserId: s.userId }, new Date());
  }

  @Post(':id/approve-review')
  @HttpCode(200)
  approveReview(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.review');
    return this.proposals.transition(scope, id, { type: 'APPROVE_REVIEW', actorUserId: s.userId }, new Date(), { reviewDecidedByUserId: s.userId });
  }

  @Post(':id/reject-review')
  @HttpCode(200)
  rejectReview(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) body: { reason: string }) {
    assertCan(s, 'proposals.review');
    return this.proposals.transition(scope, id, { type: 'REJECT_REVIEW', actorUserId: s.userId, reason: body.reason }, new Date(), {
      reviewDecidedByUserId: s.userId,
      reviewReason: body.reason,
    });
  }

  @Post(':id/mark-ready')
  @HttpCode(200)
  markReady(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.write');
    return this.proposals.transition(scope, id, { type: 'MARK_READY', actorUserId: s.userId }, new Date());
  }

  @Post(':id/send')
  @HttpCode(200)
  send(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.send');
    return this.sending.send(scope, id, new Date());
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ResendSchema)) body: { recipientId?: string }) {
    assertCan(s, 'proposals.send');
    return this.sending.resend(scope, id, body.recipientId, new Date());
  }

  @Post(':id/revise')
  @HttpCode(200)
  revise(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) body: { reason: string }) {
    assertCan(s, 'proposals.write');
    return this.sending.revise(scope, id, body.reason, new Date());
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  withdraw(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) body: { reason: string }) {
    assertCan(s, 'proposals.write');
    return this.proposals.transition(scope, id, { type: 'WITHDRAW', reason: body.reason }, new Date(), { withdrawReason: body.reason });
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReactivateSchema)) body: { reason: string; expiresOn: string }) {
    assertCan(s, 'proposals.send');
    return this.sending.reactivate(scope, id, body.reason, body.expiresOn, new Date());
  }

  @Post(':id/close-discussion')
  @HttpCode(200)
  closeDiscussion(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(OptionalReasonSchema)) _b: unknown) {
    assertCan(s, 'proposals.write');
    return this.proposals.transition(scope, id, { type: 'CLOSE_DISCUSSION' }, new Date());
  }

  @Post(':id/pricing/validate')
  @HttpCode(200)
  validatePrice(
    @CurrentScope() scope: Scope,
    @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ValidatePriceSchema)) body: { scope: 'LINE' | 'RULE' | 'CHOICE'; key: string; choiceValue?: string },
  ) {
    assertCan(s, 'proposals.prices.validate');
    return this.proposals.validatePrice(scope, id, body, new Date());
  }

  @Post(':id/sections/:key/validate')
  @HttpCode(200)
  validateSection(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string) {
    assertCan(s, 'proposals.prices.validate');
    return this.proposals.validateSection(scope, id, key, new Date());
  }

  /** Relance de l'envoi en signature (DocuSeal indisponible au moment de l'acceptation). */
  @Post(':id/start-signature')
  @HttpCode(200)
  async startSignature(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.send');
    await this.proposals.assertEnabled(scope);
    const p = await this.proposals.get(scope, id, new Date());
    return this.signature.start(systemScope(p.proposal.tenantId, p.proposal.customerId), id, null, new Date());
  }

  /** Relance manuelle de la conversion (après création du contrat type manquant). */
  @Post(':id/convert')
  @HttpCode(200)
  async convert(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.convert');
    await this.proposals.assertEnabled(scope);
    const p = await this.proposals.get(scope, id, new Date());
    return this.conversion.convert(p.proposal.tenantId, p.proposal.customerId, id, new Date());
  }

  // --- Suivi, échanges, documents ---------------------------------------------

  @Get(':id/tracking')
  tracking(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.read');
    return this.proposals.tracking(scope, id);
  }

  @Get(':id/comments')
  comments(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.read');
    return this.proposals.comments(scope, id);
  }

  @Post(':id/comments')
  reply(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReplySchema)) body: { body: string; parentId?: string; sectionKey?: string }) {
    assertCan(s, 'proposals.write');
    return this.proposals.reply(scope, id, body, new Date());
  }

  @Get(':id/pdf')
  async pdf(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply) {
    assertCan(s, 'proposals.read');
    await this.proposals.assertEnabled(scope);
    const settings = await this.proposals.settings(scope);
    const file = await this.docs.versionPdf(scope, id, settings, new Date());
    sendFile(res, { body: file.pdf, contentType: 'application/pdf', filename: file.filename });
  }

  @Get(':id/preview')
  async preview(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'proposals.read');
    await this.proposals.assertEnabled(scope);
    const settings = await this.proposals.settings(scope);
    const { html } = await this.docs.versionHtml(scope, id, settings, new Date());
    return { html };
  }
}
