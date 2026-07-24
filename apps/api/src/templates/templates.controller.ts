import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { slugifyFilename } from '../documents/filename.js';
import { TemplatesService } from './templates.service.js';
import { CreateTemplateDto } from './dto/create-template.dto.js';
import { SaveTemplateContentDto } from './dto/save-template-content.dto.js';

const ROLES = ['MSP_ADMIN', 'LEGAL_REVIEWER'] as const;

@Controller('v1/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() s: Session) {
    assertRole(s, [...ROLES]); return this.templates.list(scope);
  }

  @Get(':id')
  get(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(s, [...ROLES]); return this.templates.get(scope, id);
  }

  @Post()
  create(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Body() dto: CreateTemplateDto) {
    assertRole(s, [...ROLES]); return this.templates.create(scope, dto.name, dto.category, new Date());
  }

  @Put(':id/content')
  save(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTemplateContentDto) {
    assertRole(s, [...ROLES]); return this.templates.saveContent(scope, id, dto.bodyHtml, new Date(), s.userId);
  }

  @Post(':id/publish')
  publish(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(s, [...ROLES]); return this.templates.publish(scope, id, new Date(), s.userId);
  }

  @Post(':id/deprecate')
  deprecate(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(s, [...ROLES]); return this.templates.deprecate(scope, id, new Date());
  }

  @Get(':id/export.pdf')
  async exportPdf(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    assertRole(s, [...ROLES]);
    const { buffer, title } = await this.templates.exportPdf(scope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename(title, 'modele')}.pdf"`);
    res.send(buffer);
  }

  @Get(':id/export.docx')
  async exportDocx(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    assertRole(s, [...ROLES]);
    const { buffer, title } = await this.templates.exportDocx(scope, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename(title, 'modele')}.docx"`);
    res.send(buffer);
  }
}
