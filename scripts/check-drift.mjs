#!/usr/bin/env node
/**
 * Détection de dérive schéma.prisma ↔ migrations (script `db:check-drift`).
 *
 * Échoue (code ≠ 0) si appliquer toutes les migrations sur une base vierge ne
 * produit pas exactement le modèle décrit par schema.prisma. Utilise la base
 * « shadow » désignée par SHADOW_DATABASE_URL (jetable : Prisma la vide).
 *
 * Script Node plutôt qu'une ligne de package.json : l'expansion `$VAR` n'existe
 * pas sous cmd.exe (pnpm y exécute les scripts sous Windows).
 *
 * Portée : Prisma ne compare que ce que le datamodel sait exprimer (tables,
 * colonnes, index, clés, énumérations). Les politiques RLS, fonctions, rôles
 * et CHECK écrits à la main dans les migrations sont couverts par les tests
 * structurels de packages/persistence (tests/isolation/database-guarantees).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) {
  console.error('SHADOW_DATABASE_URL manquante : base jetable requise pour rejouer les migrations.');
  process.exit(2);
}
const persistence = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/persistence');
const r = spawnSync(
  'pnpm',
  [
    'exec', 'prisma', 'migrate', 'diff',
    '--from-migrations', 'prisma/migrations',
    '--to-schema-datamodel', 'prisma/schema.prisma',
    '--shadow-database-url', shadow,
    '--exit-code',
  ],
  { cwd: persistence, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (r.status === 2) console.error('\n✖ Dérive détectée : schema.prisma et les migrations divergent (voir le diff ci-dessus).');
process.exit(r.status ?? 1);
