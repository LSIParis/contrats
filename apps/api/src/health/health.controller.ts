import { Controller, Get, Inject, HttpException, HttpStatus, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { pingDatabase } from '@lsi/persistence';
import { Public } from '../auth/public.decorator.js';
import { REDIS } from '../auth/redis.provider.js';
import { DocusealReadiness } from '../signature/docuseal-readiness.service.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    // Optionnel : la sonde reste utilisable dans un module qui n'enregistre
    // pas la signature électronique.
    @Optional() private readonly docuseal?: DocusealReadiness,
  ) {}

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
