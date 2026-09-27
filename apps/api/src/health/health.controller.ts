import { Controller, Get, Inject, HttpException, HttpStatus, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { pingDatabase } from '@lsi/persistence';
import { Public } from '../auth/public.decorator.js';
import { REDIS } from '../auth/redis.provider.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from '../documents/document-storage.port.js';
import { DocusealReadiness } from '../signature/docuseal-readiness.service.js';

/**
 * Sondes de santé.
 *
 * - `/healthz` : liveness, CONTRAT du test de fumée de deploy.yml (annexe A) —
 *   `{status, version, revision}`. Ne touche aucune dépendance : un conteneur
 *   vivant dont la base est tombée ne doit pas être tué en boucle par Docker.
 * - `/readyz` : readiness — base, Redis, stockage (critiques → 503) ; DocuSeal
 *   est INFORMATIF (son indisponibilité neutralise la signature électronique,
 *   pas l'application — brief §7).
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
    // Optionnel : la sonde reste utilisable dans un module qui n'enregistre
    // pas la signature électronique.
    @Optional() private readonly docuseal?: DocusealReadiness,
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
    const [db, redis, storage, ds] = await Promise.all([
      pingDatabase(),
      this.redis.ping().then(() => true).catch(() => false),
      this.storage.ping().catch(() => false),
      this.docuseal ? this.docuseal.check().catch(() => null) : Promise.resolve(null),
    ]);
    // Booléens seulement : le `detail` de la sonde DocuSeal reste dans les logs.
    const docuseal = ds ? { available: ds.available, reachable: ds.reachable, tokenValid: ds.tokenValid } : null;
    const ok = db && redis && storage;
    const body = { status: ok ? 'ok' : 'unavailable', checks: { db, redis, storage, docuseal } };
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
    // DocuSeal est INFORMATIF : son indisponibilité ne rend pas l'application
    // « non prête » (le reste fonctionne), elle neutralise la signature
    // électronique (effectiveDocusealEnabled). Détail sans secret.
    const ds = this.docuseal ? await this.docuseal.check() : null;
    const docuseal = ds
      ? { available: ds.available, reachable: ds.reachable, tokenValid: ds.tokenValid, detail: ds.detail, checkedAt: ds.checkedAt }
      : undefined;
    const body = { status: ok ? 'ok' : 'degraded', checks: { db, redis, ...(docuseal ? { docuseal } : {}) } };
    if (!ok) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
