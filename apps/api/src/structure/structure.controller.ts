import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import type { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan, assertCanAny } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  ClauseLibraryService, CreateClauseSchema, NewClauseVersionSchema, TemplateStructureSchema,
} from './clause-library.service.js';
import { ReviewClauseSchema, SaveStructureSchema, StructureService, type SaveStructure } from './structure.service.js';

/** Bibliothèque de clauses, structure des modèles et des contrats (lot 2). */
@Controller('v1')
export class StructureController {
  constructor(
    private readonly library: ClauseLibraryService,
    private readonly structure: StructureService,
  ) {}

  // --- Bibliothèque -------------------------------------------------------

  @Get('clauses')
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Query('category') category?: string) {
    // Lecture ouverte à qui rédige (commercial) et à qui gère la bibliothèque (juriste).
    assertCanAny(s, ['contracts.write', 'clauses.manage']);
    return this.library.list(scope, category);
  }

  @Get('clauses/:id')
  get(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCanAny(s, ['contracts.write', 'clauses.manage']);
    return this.library.get(scope, id);
  }

  @Post('clauses')
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body(new ZodPipe(CreateClauseSchema)) body: z.infer<typeof CreateClauseSchema>) {
    assertCan(s, 'clauses.manage');
    return this.library.create(scope, body, new Date());
  }

  @Post('clauses/:id/versions')
  newVersion(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(NewClauseVersionSchema)) body: z.infer<typeof NewClauseVersionSchema>,
  ) {
    assertCan(s, 'clauses.manage');
    return this.library.newVersion(scope, id, body, new Date());
  }

  @Post('clauses/:id/archive')
  archive(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'clauses.manage');
    return this.library.archive(scope, id, new Date());
  }

  // --- Modèles ------------------------------------------------------------

  @Put('templates/:id/structure')
  setTemplateStructure(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(TemplateStructureSchema)) body: z.infer<typeof TemplateStructureSchema>,
  ) {
    assertCan(s, 'templates.manage');
    return this.library.setTemplateStructure(scope, id, body, new Date());
  }

  /** Modèles publiés, pour l'assistant de création (commercial). */
  @Get('templates-published')
  published(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'contracts.write');
    return this.library.publishedTemplates(scope);
  }

  // --- Contrats -----------------------------------------------------------

  @Get('contracts/:id/structure')
  getStructure(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'contracts.read');
    return this.structure.get(scope, id);
  }

  @Put('contracts/:id/structure')
  saveStructure(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SaveStructureSchema)) body: SaveStructure,
  ) {
    assertCan(s, 'contracts.write');
    return this.structure.save(scope, id, body, new Date());
  }

  @Post('contracts/:id/clauses/:clauseId/review')
  review(
    @CurrentScope() scope: Scope, @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('clauseId', ParseUUIDPipe) clauseId: string,
    @Body(new ZodPipe(ReviewClauseSchema)) body: z.infer<typeof ReviewClauseSchema>,
  ) {
    assertCan(s, 'clauses.validateAi');
    return this.structure.reviewClause(scope, id, clauseId, body.decision, body.comment, new Date());
  }
}
