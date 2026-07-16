import { describe, test, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: repoRoot });
});

async function lint(code: string, relPath: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: path.join(repoRoot, relPath) });
  return (res?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`);
}

/**
 * Frontière d'accès aux données. (§16.4-D, ticket S-04)
 *
 * Sans cette règle, withScope() n'est qu'une CONVENTION : rien n'empêche un
 * développeur d'importer PrismaClient et d'émettre une requête non scopée.
 * Avec elle, c'est une STRUCTURE : la seule façon de contourner le scope est
 * de désactiver explicitement une règle — visible en revue, cherchable.
 *
 * C'est toute la différence entre « sécurisé si on n'oublie pas » et
 * « sécurisé sauf si on désactive délibérément ».
 */
describe('frontière : @prisma/client est réservé au module persistence', () => {
  test('importer PrismaClient depuis un service applicatif est REFUSÉ', async () => {
    const msgs = await lint(
      `import { PrismaClient } from '@prisma/client';\nexport const p = new PrismaClient();\n`,
      'apps/api/src/contracts/contract.service.ts',
    );
    expect(msgs.join('\n')).toMatch(/no-restricted-imports/);
    expect(msgs.join('\n')).toMatch(/withScope/i);
  });

  test('importer PrismaClient depuis un worker est REFUSÉ', async () => {
    const msgs = await lint(
      `import { PrismaClient } from '@prisma/client';\n`,
      'apps/worker/src/reminders/send.job.ts',
    );
    expect(msgs.join('\n')).toMatch(/no-restricted-imports/);
  });

  test('importer PrismaClient DANS persistence est autorisé', async () => {
    const msgs = await lint(
      `import { PrismaClient } from '@prisma/client';\nexport const p = new PrismaClient();\n`,
      'packages/persistence/src/scoped-client.ts',
    );
    expect(msgs.join('\n')).not.toMatch(/no-restricted-imports/);
  });

  test('importer withScope depuis un service est autorisé', async () => {
    const msgs = await lint(
      `import { withScope } from '@lsi/persistence';\n`,
      'apps/api/src/contracts/contract.service.ts',
    );
    expect(msgs.join('\n')).not.toMatch(/no-restricted-imports/);
  });

  test('importer le client brut échappatoire est REFUSÉ hors persistence', async () => {
    const msgs = await lint(
      `import { unsafeUnscopedClient } from '@lsi/persistence';\n`,
      'apps/api/src/contracts/contract.service.ts',
    );
    expect(msgs.join('\n')).toMatch(/no-restricted-imports/);
  });
});

describe('frontière : pas de SQL non paramétré', () => {
  test('$queryRawUnsafe est REFUSÉ dans le code applicatif', async () => {
    const msgs = await lint(
      `declare const tx: any;\nexport const f = () => tx.$queryRawUnsafe('SELECT 1');\n`,
      'apps/api/src/contracts/contract.service.ts',
    );
    expect(msgs.join('\n')).toMatch(/no-restricted-syntax/);
    expect(msgs.join('\n')).toMatch(/injection/i);
  });

  test('$executeRawUnsafe est REFUSÉ dans le code applicatif', async () => {
    const msgs = await lint(
      `declare const tx: any;\nexport const f = () => tx.$executeRawUnsafe('SELECT 1');\n`,
      'apps/api/src/contracts/contract.service.ts',
    );
    expect(msgs.join('\n')).toMatch(/no-restricted-syntax/);
  });

  test('$queryRawUnsafe est toléré dans les fixtures de test', async () => {
    // Le seed prépare l'état avec le rôle propriétaire ; il n'est pas
    // exposé au réseau et ne prend aucune entrée utilisateur.
    const msgs = await lint(
      `declare const tx: any;\nexport const f = () => tx.$executeRawUnsafe('SELECT 1');\n`,
      'packages/persistence/tests/support/fixtures.ts',
    );
    expect(msgs.join('\n')).not.toMatch(/no-restricted-syntax/);
  });
});
