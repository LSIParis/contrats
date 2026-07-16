import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let container: StartedPostgreSqlContainer;

const persistenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/persistence',
);

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('lsi_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();

  execSync('pnpm exec prisma migrate deploy', {
    cwd: persistenceDir,
    env: { ...process.env },
    stdio: 'pipe',
  });

  // Les tests d'API tournent sous le rôle applicatif : non-propriétaire,
  // sans BYPASSRLS. Tester l'API sous le rôle propriétaire donnerait des
  // verts trompeurs — RLS ne s'appliquerait pas comme en production.
  const uri = new URL(container.getConnectionUri());
  uri.username = 'lsi_app';
  uri.password = 'lsi_app_test_pwd';
  process.env.DATABASE_URL_APP = uri.toString();
}

export async function teardown() {
  await container?.stop();
}
