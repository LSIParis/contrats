import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { sendFile } from '../common/http-io.js';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { slugifyFilename } from '../documents/filename.js';
import { TemplatesService } from './templates.service.js';
import { CreateTemplateDto } from './dto/create-template.dto.js';
import { SaveTemplateContentDto } from './dto/save-template-content.dto.js';


@Controller('v1/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertCan(s, 'templates.manage'); return this.templates.list(scope);
  }

  @Get(':id')
  get(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'templates.manage'); return this.templates.get(scope, id);
  }

  @Post()
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body() dto: CreateTemplateDto) {
    assertCan(s, 'templates.manage'); return this.templates.create(scope, dto.name, dto.category, new Date());
  }

  @Put(':id/content')
  save(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTemplateContentDto) {
    assertCan(s, 'templates.manage'); return this.templates.saveContent(scope, id, dto.bodyHtml, new Date(), s.userId);
  }

  @Post(':id/publish')
  publish(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'templates.manage'); return this.templates.publish(scope, id, new Date(), s.userId);
  }

  @Post(':id/deprecate')
  deprecate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertCan(s, 'templates.manage'); return this.templates.deprecate(scope, id, new Date());
  }

  @Get(':id/export.pdf')
  async exportPdf(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply) {
    assertCan(s, 'templates.manage');
    const { buffer, title } = await this.templates.exportPdf(scope, id);
    sendFile(res, { body: buffer, contentType: 'application/pdf', filename: `${slugifyFilename(title, 'modele')}.pdf` });
  }

  @Get(':id/export.docx')
  async exportDocx(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply) {
    assertCan(s, 'templates.manage');
    const { buffer, title } = await this.templates.exportDocx(scope, id);
    sendFile(res, {
      body: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${slugifyFilename(title, 'modele')}.docx`,
    });
  }
}
