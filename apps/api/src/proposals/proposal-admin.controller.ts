import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ProposalAdminService } from './proposal-admin.service.js';
import {
  ContractTemplateSlugSchema,
  LibraryItemSchema,
  TermsSchema,
  UpdateLibraryItemSchema,
  UpdateTemplateLineSchema,
  UpdateTemplateSchema,
  ValidatePendingSchema,
} from './proposals.schemas.js';

/**
 * Administration du module Propositions (brief §12.9 : l'admin gère modèles,
 * bibliothèque, seuils et CGV) et écran « Prix à valider » (annexe C).
 * Paramétrage : disponible même module désactivé, pour tout préparer avant
 * la bascule `contrats.proposals.enabled`.
 */
@Controller('v1/proposal-admin')
export class ProposalAdminController {
  constructor(private readonly admin: ProposalAdminService) {}

  @Get('templates')
  templates(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'proposals.read');
    return this.admin.templates(scope);
  }

  @Get('templates/:slug')
  template(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('slug') slug: string) {
    assertCan(s, 'proposals.read');
    return this.admin.template(scope, slug);
  }

  @Patch('templates/:slug')
  updateTemplate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('slug') slug: string, @Body(new ZodPipe(UpdateTemplateSchema)) body: Record<string, unknown>) {
    assertCan(s, 'proposals.library.manage');
    return this.admin.updateTemplate(scope, slug, body, new Date());
  }

  @Patch('templates/:slug/lines/:key')
  updateLine(
    @CurrentScope() scope: Scope,
    @CurrentSession() s: Session,
    @Param('slug') slug: string,
    @Param('key') key: string,
    @Body(new ZodPipe(UpdateTemplateLineSchema)) body: { label?: string; pricing?: unknown; priceSource?: string },
  ) {
    assertCan(s, 'proposals.library.manage');
    return this.admin.updateLine(scope, slug, key, body, new Date());
  }

  /** « Prix à valider » : lignes, règles, sections et choix TO_VALIDATE de tous les modèles. */
  @Get('pending-validations')
  pending(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'proposals.prices.validate');
    return this.admin.pending(scope);
  }

  @Post('pending-validations/validate')
  @HttpCode(200)
  validate(
    @CurrentScope() scope: Scope,
    @CurrentSession() s: Session,
    @Body(new ZodPipe(ValidatePendingSchema)) body: { templateSlug: string; scope: 'LINE' | 'RULE' | 'SECTION' | 'CHOICE'; key: string; choiceValue?: string },
  ) {
    assertCan(s, 'proposals.prices.validate');
    return this.admin.validate(scope, body, new Date());
  }

  @Get('library')
  library(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'proposals.read');
    return this.admin.library(scope);
  }

  @Post('library')
  createLibraryItem(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(LibraryItemSchema)) body: { key: string; title: string; folder: string; body: string; requiresLegalReview?: boolean }) {
    assertCan(s, 'proposals.library.manage');
    return this.admin.createLibraryItem(scope, body, new Date());
  }

  @Patch('library/:key')
  updateLibraryItem(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('key') key: string, @Body(new ZodPipe(UpdateLibraryItemSchema)) body: Record<string, unknown>) {
    assertCan(s, 'proposals.library.manage');
    return this.admin.updateLibraryItem(scope, key, body, new Date());
  }

  @Get('terms')
  terms(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'proposals.read');
    return this.admin.terms(scope);
  }

  @Post('terms')
  publishTerms(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(TermsSchema)) body: { title: string; body: string }) {
    assertCan(s, 'proposals.library.manage');
    return this.admin.publishTerms(scope, body, new Date());
  }

  @Put('contract-templates/:id/slug')
  contractTemplateSlug(
    @CurrentScope() scope: Scope,
    @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ContractTemplateSlugSchema)) body: { slug: string | null },
  ) {
    assertCan(s, 'proposals.library.manage');
    return this.admin.setContractTemplateSlug(scope, id, body.slug, new Date());
  }
}
