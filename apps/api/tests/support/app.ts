import type { TestingModule } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { configureApp, createFastifyAdapter } from '../../src/bootstrap.js';

/**
 * L'application de test EST l'application de production : même adaptateur
 * (Fastify), même configuration (`configureApp`, partagée avec main.ts), même
 * `rawBody`. Un test qui composerait sa propre application validerait une
 * configuration qui n'est pas celle qui tourne.
 */
export async function createTestApp(mod: TestingModule): Promise<NestFastifyApplication> {
  const app = mod.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { rawBody: true });
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
