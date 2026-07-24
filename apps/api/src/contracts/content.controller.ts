import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { slugifyFilename } from '../documents/filename.js';
import { ContentService } from './content.service.js';
import { SaveContentDto } from './dto/save-content.dto.js';

@Controller('v1/contracts')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Put(':id/content')
  save(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveContentDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.content.saveContent(scope, id, dto);
  }

  @Get(':id/versions')
  list(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.content.listVersions(scope, id);
  }

  @Get(':id/versions/:versionId')
  one(
    @CurrentScope() scope: Scope,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.content.getVersion(scope, id, versionId);
  }

  @Get(':id/preview.pdf')
  async preview(
    @CurrentScope() scope: Scope,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    // La méthode lève AVANT d'écrire dans `res` (404/422) : le filtre
    // d'exception de Nest répond alors normalement.
    const pdf = await this.content.previewPdf(scope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="apercu.pdf"');
    res.send(pdf);
  }

  @Get(':id/export.pdf')
  async exportPdf(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, title } = await this.content.exportPdf(scope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename(title, 'contrat')}.pdf"`);
    res.send(buffer);
  }

  @Get(':id/export.docx')
  async exportDocx(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, title } = await this.content.exportDocx(scope, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename(title, 'contrat')}.docx"`);
    res.send(buffer);
  }
}
