import { Controller, Get, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { pingDatabase } from '@lsi/persistence';
import { Public } from '../auth/public.decorator.js';
import { REDIS } from '../auth/redis.provider.js';

@Controller()
export class HealthController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

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
