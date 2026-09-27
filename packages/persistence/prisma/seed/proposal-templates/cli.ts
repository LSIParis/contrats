/**
 * Point d'entrée à appeler depuis le seed principal du dépôt (prisma/seed.ts) :
 *
 *   import { runProposalTemplatesSeed } from "./seed/proposal-templates/cli";
 *   await runProposalTemplatesSeed(prisma, process.argv.slice(2));
 *
 * Options : --tenant=<slug> (défaut : $SEED_TENANT_SLUG ou "lsi" — slug du tenant LSI-Maintenance dans ce dépôt), --force, --dry-run
 * Code de sortie non nul en cas d'erreur de validation, de conflit ou de cas de contrôle en échec.
 */
import { createPrismaSeedRepository, type PrismaLike } from "./repository";
import { seedProposalTemplates, type SeedReport } from "./seed-proposal-templates";

export async function runProposalTemplatesSeed(prisma: unknown, argv: string[] = []): Promise<SeedReport> {
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const tenantSlug = arg("tenant") ?? process.env.SEED_TENANT_SLUG ?? "lsi";
  const report = await seedProposalTemplates(createPrismaSeedRepository(prisma as PrismaLike), {
    tenantSlug,
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
    log: (m) => console.log(`[seed:propositions] ${m}`),
  });
  const pending = Object.entries(report.pendingValidations)
    .filter(([, n]) => n > 0)
    .map(([slug, n]) => `${slug} (${n})`);
  if (pending.length)
    console.log(`[seed:propositions] éléments à valider avant envoi : ${pending.join(", ")}`);
  return report;
}
