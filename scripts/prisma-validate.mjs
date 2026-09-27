#!/usr/bin/env node
/**
 * `db:validate` : validation statique de schema.prisma.
 *
 * `prisma validate` exige que DATABASE_URL soit DÉFINIE, bien qu'il ne se
 * connecte pas. Le job « quality » de ci.yml (annexe A) l'exécute sans base :
 * on fournit une URL factice si aucune n'est présente. Aucune connexion n'est
 * tentée.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const persistence = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/persistence');
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://validate:validate@localhost:5432/validate' };
const r = spawnSync('pnpm', ['exec', 'prisma', 'validate'], {
  cwd: persistence, stdio: 'inherit', env, shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
