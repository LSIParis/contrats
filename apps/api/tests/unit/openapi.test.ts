import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../../src/public-api/openapi.js';
import { generateApiKey, hashMatches, parseApiKey } from '../../src/public-api/api-key.js';
import { decodeCursor, encodeCursor } from '../../src/public-api/cursor.js';
import { RateLimiter } from '../../src/public-api/rate-limiter.js';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('OpenAPI', () => {
  test('3.1, chaque opération sécurisée par un scope, erreurs en problem+json', () => {
    const spec = buildOpenApi();
    expect(spec.openapi).toBe('3.1.0');
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods) as { security: unknown[]; responses: Record<string, { content?: Record<string, unknown> }> }[]) {
        expect(op.security).toHaveLength(1);
        expect(Object.keys(op.responses['401']!.content!)).toEqual(['application/problem+json']);
      }
    }
  });

  test('openapi.yaml et le client généré sont à jour (sinon : pnpm openapi:generate)', () => {
    execFileSync(process.execPath, ['--import', '@swc-node/register/esm-register', 'scripts/generate-openapi.ts', '--check'], { cwd: apiDir, stdio: 'pipe' });
  }, 60_000);
});

describe('clés, curseurs, débit', () => {
  test('clé : format, analyse, vérification à temps constant', () => {
    const k = generateApiKey();
    const p = parseApiKey(k.key)!;
    expect(p.prefix).toBe(k.prefix);
    expect(hashMatches(p.secret, k.hash)).toBe(true);
    expect(hashMatches(`${p.secret.slice(0, -1)}A`, k.hash)).toBe(false);
    expect(parseApiKey('ctr_court_x')).toBeNull();
  });

  test('curseur opaque : aller-retour, rejet d’un curseur forgé', () => {
    expect(decodeCursor(encodeCursor({ id: 'a' }), ['id'])).toEqual({ id: 'a' });
    expect(() => decodeCursor(encodeCursor({ autre: 'a' }), ['id'])).toThrow();
  });

  test('débit : fenêtre glissante d’une minute', () => {
    const rl = new RateLimiter();
    expect(rl.take('c', 2, 0).allowed).toBe(true);
    expect(rl.take('c', 2, 1).allowed).toBe(true);
    expect(rl.take('c', 2, 2)).toMatchObject({ allowed: false, remaining: 0 });
    expect(rl.take('c', 2, 60_001).allowed).toBe(true);
  });
});
