import { Module, Controller, Get } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BigIntInterceptor } from './common/bigint.interceptor.js';
import { ScopeGuard } from './auth/scope.guard.js';
import { SessionService } from './auth/session.service.js';
import { RedisProvider } from './auth/redis.provider.js';
import { MagicLinkService } from './auth/magic-link.service.js';
import { PortalAuthController } from './auth/portal-auth.controller.js';
import { EMAIL_SENDER } from './notifications/email.token.js';
import { BrevoSender } from './notifications/brevo.sender.js';
import { OidcAuthService } from './auth/oidc-auth.service.js';
import { InternalAuthController } from './auth/internal-auth.controller.js';
import { OIDC_PROVIDER } from './auth/oidc.port.js';
import { EntraOidcProvider } from './auth/oidc-entra.adapter.js';
import { Public } from './auth/public.decorator.js';
import { ContractsController } from './contracts/contracts.controller.js';
import { ContractsService } from './contracts/contracts.service.js';
import { DocusealWebhookController } from './webhooks/docuseal.controller.js';
import { DocusealWebhookService } from './webhooks/docuseal-webhook.service.js';
import { DocusealAdapter } from './signature/docuseal.adapter.js';
import { SendForSignatureService } from './signature/send-for-signature.service.js';
import { ESIGNATURE_PROVIDER } from './signature/provider.token.js';
import { DOCUMENT_RENDERER } from './documents/renderer.token.js';
import { GotenbergRenderer } from './documents/gotenberg.renderer.js';
import { DOCUMENT_STORAGE } from './documents/document-storage.port.js';
import { S3Storage } from './documents/s3-storage.js';
import { InMemoryStorage } from './documents/in-memory-storage.js';
import { ProofCaptureService } from './signature/proof-capture.service.js';
import { JOB_QUEUE } from './jobs/job-queue.port.js';
import { BullMqJobQueue } from './jobs/bullmq-job-queue.js';
import { NoOpJobQueue } from './jobs/noop-job-queue.js';
import { ReconciliationService } from './jobs/reconciliation.service.js';
import { SignatureWorkerService } from './jobs/signature-worker.service.js';

@Controller()
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [
    ContractsController,
    DocusealWebhookController,
    PortalAuthController,
    InternalAuthController,
    HealthController,
  ],
  providers: [
    ContractsService,
    RedisProvider,
    SessionService,
    MagicLinkService,
    OidcAuthService,
    { provide: EMAIL_SENDER, useClass: BrevoSender },
    { provide: OIDC_PROVIDER, useClass: EntraOidcProvider },
    DocusealWebhookService,
    DocusealAdapter,
    SendForSignatureService,
    ProofCaptureService,
    ReconciliationService,
    // Le worker est TOUJOURS instancié mais ne démarre sa plomberie BullMQ
    // que si WORKER_ENABLED=true : en test/dev il ne touche pas Redis.
    SignatureWorkerService,
    {
      // Producteur de jobs. Réel (BullMQ) uniquement si JOBS_ENABLED=true —
      // sinon no-op, pour qu'aucun test n'ouvre de connexion Redis. En prod,
      // tous les conteneurs API enfilent (JOBS_ENABLED), un seul consomme
      // (WORKER_ENABLED).
      provide: JOB_QUEUE,
      useClass: process.env.JOBS_ENABLED === 'true' ? BullMqJobQueue : NoOpJobQueue,
    },
    {
      // S3 si les identifiants sont fournis (prod), sinon in-memory (tests,
      // dev sans MinIO). Le service d'envoi dépend du port, pas de l'impl.
      provide: DOCUMENT_STORAGE,
      useFactory: () => (process.env.S3_ACCESS_KEY ? new S3Storage() : new InMemoryStorage()),
    },
    // Les services dépendent des PORTS, pas des adaptateurs : c'est ce qui
    // rend le changement de provider possible sans toucher au métier (§11.1),
    // et ce qui permet de tester la logique d'envoi sans DocuSeal ni Chromium.
    { provide: ESIGNATURE_PROVIDER, useExisting: DocusealAdapter },
    { provide: DOCUMENT_RENDERER, useClass: GotenbergRenderer },
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
