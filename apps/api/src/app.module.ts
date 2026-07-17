import { Module, Controller, Get } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BigIntInterceptor } from './common/bigint.interceptor.js';
import { ScopeGuard } from './auth/scope.guard.js';
import { SessionService } from './auth/session.service.js';
import { Public } from './auth/public.decorator.js';
import { ContractsController } from './contracts/contracts.controller.js';
import { ContractsService } from './contracts/contracts.service.js';
import { DocusealWebhookController } from './webhooks/docuseal.controller.js';
import { DocusealWebhookService } from './webhooks/docuseal-webhook.service.js';
import { DocusealAdapter } from './signature/docuseal.adapter.js';

@Controller()
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [ContractsController, DocusealWebhookController, HealthController],
  providers: [
    ContractsService,
    SessionService,
    DocusealWebhookService,
    DocusealAdapter,
    {
      // LE point clé de l'architecture (§9.2, §10.5).
      //
      // APP_GUARD s'applique à TOUTES les routes, présentes ET futures.
      // Une route nouvelle est gardée par défaut : le développeur n'a rien à
      // penser. S'en soustraire exige @Public(), explicite et cherchable.
      //
      // C'est la raison principale du choix NestJS plutôt que Next.js : avec
      // des route handlers, chaque handler devrait penser à se scoper, et
      // l'oubli n'aurait cassé rien — il aurait silencieusement élargi le
      // périmètre. Le pire mode de défaillance possible.
      provide: APP_GUARD,
      useClass: ScopeGuard,
    },
    {
      // Les montants sont des BigInt (centimes entiers) : sans cela,
      // JSON.stringify lève et l'API renvoie 500 sur le premier contrat
      // portant un montant.
      provide: APP_INTERCEPTOR,
      useClass: BigIntInterceptor,
    },
  ],
})
export class AppModule {}
