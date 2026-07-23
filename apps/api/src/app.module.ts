import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { LoggerModule } from 'nestjs-pino';
import { LOG_REDACT_PATHS, logReqSerializer } from './observability/logging.js';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@lsi/persistence';
import { BigIntInterceptor } from './common/bigint.interceptor.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { ScopeGuard } from './auth/scope.guard.js';
import { SessionService } from './auth/session.service.js';
import { RedisProvider } from './auth/redis.provider.js';
import { MagicLinkService } from './auth/magic-link.service.js';
import { PortalAuthController } from './auth/portal-auth.controller.js';
import { EMAIL_SENDER } from './notifications/email.token.js';
import { BrevoSender } from './notifications/brevo.sender.js';
import { OidcAuthService } from './auth/oidc-auth.service.js';
import { InternalAuthController } from './auth/internal-auth.controller.js';
import { MeController } from './auth/me.controller.js';
import { DashboardController } from './read/dashboard.controller.js';
import { DashboardService } from './read/dashboard.service.js';
import { RemindersController } from './read/reminders.controller.js';
import { RemindersReadService } from './read/reminders.service.js';
import { OIDC_PROVIDER } from './auth/oidc.port.js';
import { EntraOidcProvider } from './auth/oidc-entra.adapter.js';
import { HealthController } from './health/health.controller.js';
import { ContractsController } from './contracts/contracts.controller.js';
import { ContractsService } from './contracts/contracts.service.js';
import { ContentController } from './contracts/content.controller.js';
import { ContentService } from './contracts/content.service.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomersService } from './customers/customers.service.js';
import { UsersController } from './users/users.controller.js';
import { UsersService } from './users/users.service.js';
import { PortalContractsController } from './portal/portal-contracts.controller.js';
import { PortalService } from './portal/portal.service.js';
import { ClientPortalGuard } from './portal/client-portal.guard.js';
import { SignersController } from './contracts/signers.controller.js';
import { SignersService } from './contracts/signers.service.js';
import { CommentsController } from './comments/comments.controller.js';
import { CommentsService } from './comments/comments.service.js';
import { DocusealWebhookController } from './webhooks/docuseal.controller.js';
import { DocusealWebhookService } from './webhooks/docuseal-webhook.service.js';
import { DocusealAdapter } from './signature/docuseal.adapter.js';
import { SendForSignatureService } from './signature/send-for-signature.service.js';
import { SignatureActionsController } from './signature/signature-actions.controller.js';
import { SignatureActionsService } from './signature/signature-actions.service.js';
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
import { LifecycleService } from './jobs/lifecycle.service.js';
import { ReminderDispatchService } from './jobs/reminder-dispatch.service.js';
import { ReminderSendService } from './jobs/reminder-send.service.js';
import { SignatureWorkerService } from './jobs/signature-worker.service.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { AuditService } from './audit/audit.service.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditReadService } from './audit/audit-read.service.js';
import { TemplatesController } from './templates/templates.controller.js';
import { TemplatesService } from './templates/templates.service.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
        autoLogging: process.env.NODE_ENV !== 'test',
        // Redaction des credentials : en-têtes entrants (cookie de session,
        // Authorization) ET le Set-Cookie SORTANT (le sessionId est un bearer :
        // le loguer en clair = fuite d'auth dans stdout → Portainer → backups).
        redact: LOG_REDACT_PATHS,
        serializers: { req: logReqSerializer },
        genReqId: (req: any, res: any) => {
          const incoming = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;
          const id = incoming ?? uuidv7();
          res.setHeader('x-request-id', id);
          return id;
        },
      },
    }),
    ServeStaticModule.forRoot({
      // Le bundle Vite ; en dev il peut être absent (Vite sert lui-même) —
      // ServeStatic renvoie alors 404 sur les routes SPA, ce qui est sans effet
      // puisque le dev passe par le serveur Vite (proxy /v1 → 3001).
      //
      // ATTENTION : résolu depuis `import.meta.url` (l'emplacement RÉEL de ce
      // fichier), JAMAIS depuis `process.cwd()`. En production, le CMD du
      // Dockerfile est `pnpm --filter @lsi/api exec node ... src/main.ts` —
      // `pnpm --filter <pkg> exec` lance le process avec cwd = le dossier du
      // package (`/app/apps/api`), PAS la racine du repo. Un `join(cwd(),
      // 'apps/web/dist')` visait donc `/app/apps/api/apps/web/dist`, qui
      // n'existe pas : le build réel est le dossier frère `/app/apps/web/dist`.
      // Résultat en prod : le SPA n'était JAMAIS servi (chaque route non-/v1
      // tombait sur un sendFile d'un chemin absent). `import.meta.url` pointe
      // sur ce fichier source (`.../apps/api/src/app.module.ts`, exécuté via
      // SWC) et sa résolution relative est indépendante du cwd du process.
      rootPath: fileURLToPath(new URL('../../web/dist', import.meta.url)),
      // JAMAIS capturer l'API ni le healthcheck avec le repli index.html.
      //
      // ATTENTION : `@nestjs/serve-static@4.0.2` compile `exclude` avec
      // `path-to-regexp@0.2.5` (Express 4). Dans CETTE version, un `*` nu
      // (pas rattaché à un `:nom` ou `(...)`) est un ASTÉRISQUE LITTÉRAL,
      // pas un joker — `/v1*` ne matche donc RIEN (ni `/v1`, ni `/v1/x`) et
      // ne fait JAMAIS ce qu'on croit lire. C'est un piège classé « looks
      // right, does nothing » : ne JAMAIS « simplifier » en `/v1*`.
      // `/v1/:path*` (paramètre nommé + `*`) matche bien `/v1`, `/v1/x` et
      // `/v1/x/y/z` — vérifié avec `pathToRegexp('/v1/:path*').exec(...)`.
      exclude: ['/v1/:path*', '/health'],
    }),
  ],
  controllers: [
    ContractsController,
    ContentController,
    CustomersController,
    UsersController,
    SignersController,
    CommentsController,
    PortalContractsController,
    DocusealWebhookController,
    SignatureActionsController,
    PortalAuthController,
    InternalAuthController,
    MeController,
    DashboardController,
    RemindersController,
    NotificationsController,
    AuditController,
    HealthController,
    TemplatesController,
  ],
  providers: [
    ContractsService,
    ContentService,
    CustomersService,
    UsersService,
    SignersService,
    CommentsService,
    PortalService,
    DashboardService,
    RemindersReadService,
    NotificationsService,
    AuditService,
    AuditReadService,
    TemplatesService,
    RedisProvider,
    SessionService,
    MagicLinkService,
    OidcAuthService,
    { provide: EMAIL_SENDER, useClass: BrevoSender },
    { provide: OIDC_PROVIDER, useClass: EntraOidcProvider },
    DocusealWebhookService,
    DocusealAdapter,
    SendForSignatureService,
    SignatureActionsService,
    ProofCaptureService,
    ReconciliationService,
    LifecycleService,
    ReminderDispatchService,
    ReminderSendService,
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
      // Deny-by-default pour les sessions CLIENT (§6.15, H11) : après
      // ScopeGuard (qui pose req.session), confine toute session
      // actorKind='CLIENT' à /v1/portal/*. L'ordre de déclaration des
      // providers APP_GUARD EST l'ordre d'exécution — doit rester APRÈS
      // ScopeGuard.
      provide: APP_GUARD,
      useClass: ClientPortalGuard,
    },
    {
      // Les montants sont des BigInt (centimes entiers) : sans cela,
      // JSON.stringify lève et l'API renvoie 500 sur le premier contrat
      // portant un montant.
      provide: APP_INTERCEPTOR,
      useClass: BigIntInterceptor,
    },
    {
      // Journal d'audit inviolable (§6.9) : audite toutes les mutations
      // authentifiées réussies (POST/PUT/PATCH/DELETE, 2xx). Best-effort —
      // un échec d'écriture d'audit ne casse jamais la requête utilisateur.
      // Plusieurs APP_INTERCEPTOR sont supportés ; l'ordre de déclaration
      // est l'ordre d'exécution (celui-ci s'exécute après BigIntInterceptor).
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
    {
      // Filtre d'exception global (§3.3) : PRÉSERVE le corps d'erreur existant
      // (HttpException.getResponse(), objet ou string) et y AJOUTE requestId
      // pour la corrélation. Erreur inconnue → 500 générique sans fuite de
      // stack. Ne logue QUE les 5xx (les 4xx sont déjà tracées par pino-http).
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
