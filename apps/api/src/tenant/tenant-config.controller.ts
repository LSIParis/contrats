import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import type { z } from 'zod';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { FEATURE_FLAGS, FlagBody, SettingBody } from './tenant-config.js';
import { TenantConfigService } from './tenant-config.service.js';

@Controller('v1')
export class TenantConfigController {
  constructor(private readonly config: TenantConfigService) {}

  /** Lecture des drapeaux pour toute session interne : l'interface s'y adapte. */
  @Get('feature-flags')
  async flags(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertCan(session, 'contracts.read');
    return { flags: await this.config.flags(scope), descriptions: FEATURE_FLAGS };
  }

  @Put('admin/feature-flags/:key')
  setFlag(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('key') key: string,
    @Body(new ZodPipe(FlagBody)) body: z.infer<typeof FlagBody>,
  ) {
    assertCan(session, 'tenant.configure');
    return this.config.setFlag(scope, key, body.enabled, new Date());
  }

  @Get('admin/settings')
  async settings(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertCan(session, 'tenant.configure');
    return { settings: await this.config.settings(scope) };
  }

  @Put('admin/settings/:key')
  setSetting(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('key') key: string,
    @Body(new ZodPipe(SettingBody)) body: z.infer<typeof SettingBody>,
  ) {
    assertCan(session, 'tenant.configure');
    return this.config.setSetting(scope, key, body.value, new Date());
  }
}
