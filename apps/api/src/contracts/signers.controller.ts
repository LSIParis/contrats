import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession } from '../auth/current-scope.decorator.js';
import { assertCan } from '../auth/permissions.js';
import type { Session } from '../auth/session.service.js';
import { SignersService } from './signers.service.js';
import { AddSignerDto } from './dto/add-signer.dto.js';

@Controller('v1/contracts')
export class SignersController {
  constructor(private readonly signers: SignersService) {}

  @Post(':id/signers')
  add(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddSignerDto,
  ) {
    assertCan(session, 'contracts.write');
    return this.signers.add(scope, id, dto);
  }

  @Delete(':id/signers/:signerId')
  @HttpCode(204)
  remove(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('signerId', ParseUUIDPipe) signerId: string,
  ) {
    assertCan(session, 'contracts.write');
    return this.signers.remove(scope, id, signerId);
  }
}
