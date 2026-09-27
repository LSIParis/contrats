import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

/**
 * Point d'entrée du conteneur `worker`. (docs/contrats/00-architecture.md §2)
 *
 * MÊME image, MÊME module que l'API : les deux processus tournent exactement
 * la même version du code métier. Seul change le mode de démarrage — un
 * contexte applicatif SANS serveur HTTP, qui consomme la file BullMQ et porte
 * les tâches planifiées (échéancier, réconciliation DocuSeal, OCR, webhooks
 * sortants, purge RGPD).
 *
 * WORKER_ENABLED est forcé ici plutôt que laissé à la configuration : un
 * conteneur lancé avec cette commande n'a aucune autre raison d'exister.
 * Inversement, le conteneur `app` doit être configuré WORKER_ENABLED=false,
 * sinon les tâches planifiées tourneraient deux fois.
 */
async function bootstrap() {
  process.env.WORKER_ENABLED = 'true';
  process.env.JOBS_ENABLED = 'true';
  const ctx = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  ctx.useLogger(ctx.get(Logger));
  ctx.enableShutdownHooks();
  ctx.get(Logger).log(`worker démarré (version ${process.env.APP_VERSION ?? 'dev'})`);
}

void bootstrap();
