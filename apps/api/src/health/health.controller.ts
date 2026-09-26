import { Controller, Get, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { pingDatabase } from '@lsi/persistence';
import { Public } from '../auth/public.decorator.js';
import { REDIS } from '../auth/redis.provider.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';

/**
 * Sondes de santé.
 *
 * - `/healthz` : liveness, CONTRAT du test de fumée de deploy.yml (annexe A) —
 *   `{status, version, revision}`. Ne touche aucune dépendance : un conteneur
 *   vivant dont la base est tombée ne doit pas être tué en boucle par Docker.
 * - `/readyz` : readiness — base, Redis, stockage (critiques → 503).
 * - `/health`, `/health/ready` : sondes historiques conservées pour la
 *   supervision déjà en place (Uptime Kuma). À retirer une fois migrée.
 *
 * Aucune de ces réponses ne contient d'URL, de nom d'hôte ni de message
 * d'erreur : une sonde publique n'est pas un outil de reconnaissance.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  @Public()
  @Get('healthz')
  healthz() {
    return {
      status: 'ok',
      version: process.env.APP_VERSION || 'dev',
      revision: process.env.GIT_SHA || 'unknown',
    };
  }

  @Public()
  @Get('readyz')
  async readyz() {
    const [db, redis, storage] = await Promise.all([
      pingDatabase(),
      this.redis.ping().then(() => true).catch(() => false),
      this.storage.ping().catch(() => false),
    ]);
    const checks = { db, redis, storage };
    const ok = db && redis && storage;
    const body = { status: ok ? 'ok' : 'unavailable', checks };
    if (!ok) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Public()
  @Get('health/ready')
  async ready() {
    const [db, redis] = await Promise.all([
      pingDatabase(),
      this.redis.ping().then(() => true).catch(() => false),
    ]);
    const ok = db && redis;
    const body = { status: ok ? 'ok' : 'degraded', checks: { db, redis } };
    if (!ok) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
