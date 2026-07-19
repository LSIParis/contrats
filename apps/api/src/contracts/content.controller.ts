import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
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
}
