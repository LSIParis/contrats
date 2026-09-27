/**
 * Seed des données de RÉFÉRENCE du tenant (annexe C du brief).
 *
 *   pnpm db:seed                      tous les seeds de référence
 *   pnpm db:seed:propositions         modèles de proposition + bibliothèque de contenus
 *   … -- --dry-run | --force | --tenant=<slug>
 *
 * S'exécute avec le rôle PROPRIÉTAIRE (DATABASE_URL), comme les migrations :
 * deploy/migrate.sh l'appelle après `prisma migrate deploy` quand
 * SEED_PROPOSAL_TEMPLATES=true. Idempotent : un second passage ne change rien,
 * un modèle modifié dans l'interface n'est jamais réécrit (sauf --force). Un
 * fichier invalide ou un cas de contrôle en échec fait échouer le seed AVANT
 * toute écriture — donc le job de migration, donc le déploiement.
 */
import { PrismaClient } from '@prisma/client';
import { runProposalTemplatesSeed } from './seed/proposal-templates/cli';

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

try {
  if (!only || only === 'propositions') {
    await runProposalTemplatesSeed(prisma, argv.filter((a) => !a.startsWith('--only=')));
  }
} catch (e) {
  console.error(`[seed] échec : ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
