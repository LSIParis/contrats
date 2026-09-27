/**
 * Seed idempotent des modèles de proposition et de la bibliothèque de contenus.
 *
 * Pour chaque élément (modèle ou contenu de bibliothèque) :
 * - absent en base                      -> CREATED
 * - modifié dans l'interface            -> SKIPPED_MODIFIED (jamais écrasé ; --force restaure la version du seed)
 * - même seedVersion, même checksum     -> UNCHANGED
 * - même seedVersion, checksum différent-> erreur : incrémenter seedVersion dans le JSON
 * - seedVersion du fichier supérieure   -> UPDATED (remplacement complet, en transaction)
 * - seedVersion en base supérieure      -> SKIPPED_NEWER
 *
 * Tout est validé (Zod + références croisées + cas de contrôle chiffrés) avant la
 * première écriture : un fichier invalide n'écrit rien.
 */
import { checksum, loadSeed, type LoadedSeed } from "./load";
import { runControlCases, listPendingValidations } from "./reference-pricing";
import type { SeedRepository, SeedState } from "./repository";

export type SeedOutcome = "CREATED" | "UPDATED" | "UNCHANGED" | "SKIPPED_MODIFIED" | "SKIPPED_NEWER";

export interface SeedReport {
  tenantSlug: string;
  library: Record<string, SeedOutcome>;
  templates: Record<string, SeedOutcome>;
  warnings: string[];
  /** Nombre d'éléments « à valider » par modèle, pour l'écran d'administration. */
  pendingValidations: Record<string, number>;
}

export interface SeedOptions {
  tenantSlug: string;
  force?: boolean;
  dryRun?: boolean;
  seed?: LoadedSeed;
  log?: (msg: string) => void;
}

export class SeedConflictError extends Error {
  name = "SeedConflictError";
}

function decide(existing: SeedState | null, version: number, sum: string, force: boolean, label: string): SeedOutcome {
  if (!existing) return "CREATED";
  if (existing.userModifiedAt) return force ? "UPDATED" : "SKIPPED_MODIFIED";
  const current = existing.seedVersion ?? 0;
  if (current > version && !force) return "SKIPPED_NEWER";
  if (current === version && existing.seedChecksum === sum) return "UNCHANGED";
  if (current === version && !force)
    throw new SeedConflictError(
      `${label} : contenu modifié sans incrément de seedVersion (${version}). Incrémentez seedVersion dans le fichier JSON.`,
    );
  return "UPDATED";
}

export async function seedProposalTemplates(repo: SeedRepository, opts: SeedOptions): Promise<SeedReport> {
  const log = opts.log ?? (() => {});
  const seed = opts.seed ?? loadSeed();
  const force = !!opts.force;

  const failures = seed.templates.flatMap((t) => runControlCases(t));
  if (failures.length) throw new Error(`Cas de contrôle en échec :\n - ${failures.join("\n - ")}`);

  const tenantId = await repo.findTenantIdBySlug(opts.tenantSlug);
  if (!tenantId) throw new Error(`Tenant introuvable : ${opts.tenantSlug}`);

  const report: SeedReport = {
    tenantSlug: opts.tenantSlug,
    library: {},
    templates: {},
    warnings: [],
    pendingValidations: {},
  };

  // Décisions calculées d'abord (détection des conflits avant toute écriture).
  const libPlan = [];
  for (const item of seed.library) {
    const sum = checksum(item);
    const existing = await repo.findLibraryItem(tenantId, item.key);
    libPlan.push({ item, sum, existing, outcome: decide(existing, item.seedVersion, sum, force, `bibliothèque ${item.key}`) });
  }
  const tplPlan = [];
  for (const t of seed.templates) {
    const sum = checksum(t);
    const existing = await repo.findTemplate(tenantId, t.slug);
    tplPlan.push({ t, sum, existing, outcome: decide(existing, t.seedVersion, sum, force, `modèle ${t.slug}`) });
  }

  for (const p of libPlan) {
    report.library[p.item.key] = p.outcome;
    if (p.outcome === "SKIPPED_MODIFIED")
      report.warnings.push(`Contenu « ${p.item.key} » modifié dans l'interface : non mis à jour.`);
    if ((p.outcome === "CREATED" || p.outcome === "UPDATED") && !opts.dryRun)
      await repo.saveLibraryItem(tenantId, p.item, p.sum, p.existing?.id);
  }
  for (const p of tplPlan) {
    report.templates[p.t.slug] = p.outcome;
    report.pendingValidations[p.t.slug] = listPendingValidations(p.t).length;
    if (p.outcome === "SKIPPED_MODIFIED")
      report.warnings.push(`Modèle « ${p.t.slug} » modifié dans l'interface : non mis à jour.`);
    if (!(await repo.contractTemplateExists(tenantId, p.t.contractTemplateSlug)))
      report.warnings.push(
        `Modèle « ${p.t.slug} » : contrat type « ${p.t.contractTemplateSlug} » absent ; la conversion en contrat échouera tant qu'il n'existe pas.`,
      );
    if ((p.outcome === "CREATED" || p.outcome === "UPDATED") && !opts.dryRun)
      await repo.saveTemplate(tenantId, p.t, p.sum, p.existing?.id);
  }

  for (const [k, v] of Object.entries({ ...report.library, ...report.templates })) log(`${v.padEnd(16)} ${k}`);
  for (const w of report.warnings) log(`ATTENTION ${w}`);
  return report;
}
