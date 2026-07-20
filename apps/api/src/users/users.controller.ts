import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { UsersService } from './users.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

@Controller('v1/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentScope() scope: Scope, @CurrentSession() session: Session) {
    assertRole(session, ['MSP_ADMIN']);
    return this.users.list(scope);
  }

  @Post()
  create(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Body() dto: CreateUserDto) {
    assertRole(session, ['MSP_ADMIN']);
    return this.users.create(scope, dto);
  }

  @Patch(':id')
  update(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    assertRole(session, ['MSP_ADMIN']);
    return this.users.update(scope, id, dto);
  }
}
