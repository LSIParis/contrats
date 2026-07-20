import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { ContractsService } from './contracts.service.js';
import { SendForSignatureService } from '../signature/send-for-signature.service.js';
import { CreateContractDto } from './dto/create-contract.dto.js';
import { SendForSignatureDto } from './dto/send-for-signature.dto.js';
import { ListContractsDto } from './dto/list-contracts.dto.js';
import { TerminateContractDto } from './dto/terminate-contract.dto.js';
import { RefuseRenewalDto } from './dto/refuse-renewal.dto.js';
import { AmendContractDto } from './dto/amend-contract.dto.js';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { IsString, MinLength } from 'class-validator';

class ReasonDto {
  @IsString()
  @MinLength(1, { message: 'Un motif est obligatoire.' })
  reason!: string;
}

/**
 * API contrats. (§14.4)
 *
 * Les transitions d'état sont des SOUS-RESSOURCES D'ACTION
 * (POST /contracts/:id/submit), jamais un PATCH {status: 'APPROVED'}.
 *
 * Un PATCH de statut serait une erreur de conception : une transition n'est
 * pas une affectation de champ. Elle a des gardes, des effets de bord et des
 * acteurs distincts. L'URL doit dire l'intention.
 *
 * Aucune méthode ne lit tenantId : @CurrentScope vient de la session (RM-29).
 */
@Controller('v1/contracts')
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly send: SendForSignatureService,
  ) {}

  @Post()
  async create(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Body() dto: CreateContractDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.create(scope, dto, new Date());
  }

  @Get()
  async list(@CurrentScope() scope: Scope, @Query() q: ListContractsDto) {
    return this.contracts.list(scope, q);
  }

  @Get(':id')
  async findOne(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    // 404 si hors scope, jamais 403 : un 403 confirmerait l'existence et
    // transformerait l'API en oracle d'énumération (RM-30).
    return this.contracts.findOne(scope, id);
  }

  @Get(':id/signed-document')
  async signedDocument(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    // URL présignée à durée courte : jamais d'URL S3 durable en base (§10.7).
    return this.contracts.signedDocumentUrl(scope, id);
  }

  @Get(':id/allowed-actions')
  async allowed(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    // Permet à l'interface de désactiver les bons boutons sans dupliquer
    // la machine à états côté client (§14.3).
    return { allowedActions: await this.contracts.allowedActions(scope, id) };
  }

  @Post(':id/submit')
  async submit(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.applyEvent(
      scope,
      id,
      { type: 'SUBMIT_FOR_REVIEW', actorUserId: session.userId },
      new Date(),
    );
  }

  @Post(':id/approve')
  async approve(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // RM-10 : le rôle autorise, mais le DOMAINE refusera si l'acteur est
    // celui qui a soumis. Rôle, scope et état sont trois contrôles distincts.
    assertRole(session, ['MSP_ADMIN', 'LEGAL_REVIEWER']);
    return this.contracts.applyEvent(
      scope,
      id,
      { type: 'APPROVE', actorUserId: session.userId },
      new Date(),
    );
  }

  @Post(':id/request-changes')
  async requestChanges(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'LEGAL_REVIEWER']);
    return this.contracts.applyEvent(
      scope,
      id,
      { type: 'REQUEST_CHANGES', actorUserId: session.userId, reason: dto.reason },
      new Date(),
    );
  }

  @Post(':id/send-for-signature')
  @HttpCode(202)
  async sendForSignature(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendForSignatureDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);

    // Obligatoire, pas optionnelle. Sans clé, un timeout réseau suivi d'un
    // réessai enverrait DEUX invitations au client (§11.8). On refuse plutôt
    // que de générer une clé nous-mêmes : une clé générée côté serveur serait
    // différente à chaque tentative, donc inutile.
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'L’en-tête Idempotency-Key est obligatoire sur cette opération.',
      });
    }

    // 202 et non 201 : la création chez le provider est asynchrone du point
    // de vue du client. Répondre 201 ferait mentir l'API sur un état qui
    // n'existe pas encore (§14.4).
    return this.send.send(scope, id, dto, idempotencyKey, new Date());
  }

  @Post(':id/terminate')
  async terminate(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateContractDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.terminate(scope, id, dto, session, new Date());
  }

  @Post(':id/renew')
  async renew(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.renew(scope, id, session, new Date());
  }

  @Post(':id/renew/refuse')
  async refuseRenewal(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefuseRenewalDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.refuseRenewal(scope, id, dto.reason, session, new Date());
  }

  @Post(':id/amend')
  async amend(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmendContractDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.amend(scope, id, dto, session, new Date());
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    return this.contracts.applyEvent(
      scope,
      id,
      { type: 'CANCEL', actorUserId: session.userId, reason: dto.reason.trim() },
      new Date(),
    );
  }
}
