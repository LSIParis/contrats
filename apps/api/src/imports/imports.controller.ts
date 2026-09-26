import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { MAX_FILES_PER_REQUEST } from '../bootstrap.js';
import { readMultipart, readMultipartFiles, sendFile } from '../common/http-io.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { slugifyFilename } from '../documents/filename.js';
import { ImportMetaSchema, ImportsService, ValidateImportSchema, type ValidateImport } from './imports.service.js';

/** Reprise des contrats existants — 03-import-existant.md §5. */
@Controller('v1/contracts')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** Dépôt unitaire : multipart `document` + métadonnées (customerId obligatoire). */
  @Post('import')
  async importOne(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Req() req: FastifyRequest) {
    assertCan(session, 'contracts.import');
    const { file, fields } = await readMultipart(req, 'document');
    const meta = new ZodPipe(ImportMetaSchema).transform(fields);
    if (!file) throw new BadRequestException('Document manquant.');
    return this.imports.importOne(scope, meta, file, new Date());
  }

  /** Dépôt par lot : plusieurs `documents` pour UN client ; un contrat par fichier. */
  @Post('import/batch')
  async importBatch(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Req() req: FastifyRequest) {
    assertCan(session, 'contracts.import');
    const { files, fields } = await readMultipartFiles(req, 'documents', MAX_FILES_PER_REQUEST);
    const { customerId } = new ZodPipe(z.object({ customerId: z.uuid() }).strict()).transform(fields);
    return this.imports.importBatch(scope, customerId, files, new Date());
  }

  /** Données de l'écran de validation côte à côte. */
  @Get(':id/import')
  get(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'contracts.read');
    return this.imports.get(scope, id);
  }

  /** PDF recherchable produit par l'OCR (copie de travail — jamais l'original). */
  @Get(':id/import/ocr.pdf')
  async ocrPdf(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: FastifyReply,
  ) {
    assertCan(session, 'contracts.read');
    const { buffer, reference } = await this.imports.ocrPdf(scope, id);
    sendFile(res, {
      body: buffer, contentType: 'application/pdf', disposition: 'inline',
      filename: `${slugifyFilename(reference, 'contrat')}-ocr.pdf`,
    });
  }

  @Post(':id/import/validate')
  validate(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ValidateImportSchema)) body: ValidateImport,
  ) {
    assertCan(session, 'imports.validate');
    return this.imports.validate(scope, id, body, new Date());
  }

  @Post(':id/import/retry-ocr')
  retry(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(session, 'contracts.import');
    return this.imports.retryOcr(scope, id, new Date());
  }
}
