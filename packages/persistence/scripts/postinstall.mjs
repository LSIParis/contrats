// Génère le client Prisma après `pnpm install` (CI, postes de développement),
// pour que `pnpm typecheck` voie les types du schéma sans étape manuelle.
// Sans schéma (étape « dépendances » du Dockerfile, qui ne copie que les
// package.json) : rien à faire, le Dockerfile génère le client ensuite.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!existsSync(new URL('../prisma/schema.prisma', import.meta.url))) {
  console.log('postinstall @lsi/persistence : schéma Prisma absent, génération différée.');
  process.exit(0);
}
const r = spawnSync('prisma', ['generate'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
