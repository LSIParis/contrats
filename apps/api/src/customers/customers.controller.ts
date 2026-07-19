import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { CustomersService } from './customers.service.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';

@Controller('v1/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@CurrentScope() scope: Scope) {
    return this.customers.list(scope);
  }

  @Get(':id')
  findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(scope, id);
  }

  @Post()
  create(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Body() dto: CreateCustomerDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.customers.create(scope, session, dto);
  }
}
