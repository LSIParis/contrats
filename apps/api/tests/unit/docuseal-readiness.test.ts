import { describe, test, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { ProviderReadiness } from '@lsi/domain';
import { DocusealReadiness, effectiveDocusealEnabled } from '../../src/signature/docuseal-readiness.service.js';
import { AppModule } from '../../src/app.module.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { FakeProvider } from '../support/fakes.js';

/**
 * Mode dégradé DocuSeal (brief §7) : une panne de DocuSeal neutralise la
 * signature électronique, SANS rendre l'application indisponible.
 */

class CountingProvider extends FakeProvider {
  probes = 0;
  override async checkReadiness(): Promise<ProviderReadiness> {
    this.probes++;
    await new Promise((r) => setTimeout(r, 5));
    return this.readiness;
  }
}

describe('DocusealReadiness', () => {
  test('jamais sondé : indisponible (on ne promet pas ce qu’on n’a pas vérifié)', () => {
    const r = new DocusealReadiness(new CountingProvider());
    expect(r.isAvailable()).toBe(false);
    expect(r.snapshot()).toBeNull();
  });

  test('disponible seulement si joignable ET jeton valide', async () => {
    const p = new CountingProvider();
    const r = new DocusealReadiness(p);
    expect((await r.refresh()).available).toBe(true);

    p.readiness = { reachable: true, tokenValid: false, detail: 'jeton refusé (HTTP 401)' };
    const snap = await r.refresh();
    expect(snap.available).toBe(false);
    expect(snap.detail).toContain('401');
    expect(r.isAvailable()).toBe(false);
  });

  test('cache : check() ne resonde pas avant l’échéance', async () => {
    const p = new CountingProvider();
    const r = new DocusealReadiness(p);
    await r.check();
    await r.check();
    await r.check();
    expect(p.probes).toBe(1);
    await r.check(0); // âge maximal nul : sonde forcée
    expect(p.probes).toBe(2);
  });

  test('sondes concurrentes dédupliquées', async () => {
    const p = new CountingProvider();
    const r = new DocusealReadiness(p);
    await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
    expect(p.probes).toBe(1);
  });

  test('une sonde qui lève est traduite en « indisponible », jamais propagée', async () => {
    const p = new CountingProvider();
    p.checkReadiness = async () => {
      throw new Error('boom');
    };
    const snap = await new DocusealReadiness(p).refresh();
    expect(snap).toMatchObject({ available: false, reachable: false, detail: 'boom' });
  });
});

describe('effectiveDocusealEnabled — neutralisation du flag contrats.docuseal.enabled', () => {
  test.each([
    [true, { available: true }, true],
    [true, { available: false }, false],
    [true, null, false],
    [false, { available: true }, false],
  ])('flag=%s état=%j → %s', (flag, state, expected) => {
    expect(effectiveDocusealEnabled(flag, state)).toBe(expected);
  });
});

describe('/health/ready', () => {
  test('DocuSeal indisponible : 200 (l’application reste prête), checks.docuseal explicite', async () => {
    const provider = new FakeProvider();
    provider.readiness = { reachable: false, tokenValid: false, detail: 'DocuSeal sonde : délai dépassé' };
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ESIGNATURE_PROVIDER)
      .useValue(provider)
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.docuseal).toMatchObject({ available: false, reachable: false, tokenValid: false });
      expect(res.body.checks.docuseal.detail).toContain('délai');
    } finally {
      await app.close();
    }
  });
});
