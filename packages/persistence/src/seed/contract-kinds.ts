/**
 * Types de contrats prédéfinis et durées d'engagement (`pnpm seed:contract-kinds`,
 * docs/contrats/13-types-contrats.md).
 *
 * - Sans tarifs ni contenu contractuel : l'utilisateur les saisit.
 * - Idempotent et conservateur : un type (par `systemKey`) ou une durée (par
 *   nombre de mois) déjà présent n'est JAMAIS modifié — libellé et préfixe
 *   modifiés dans l'application sont conservés. Seuls les manquants sont créés.
 * - Un préfixe proposé déjà pris par un type créé par l'utilisateur : le type
 *   prédéfini n'est pas créé, et c'est signalé (à renommer, puis relancer).
 *
 * Connexion : rôle propriétaire (SEED_DATABASE_URL, sinon DATABASE_URL), comme
 * les migrations. Tenant : SEED_TENANT_SLUG (défaut `lsi`).
 */
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../uuid.js';
import { createPrismaClient } from '../prisma-client.js';

export const DEFAULT_COMMITMENT_TERMS: readonly { months: number; label: string }[] = [
  { months: 0, label: 'Sans engagement' },
  { months: 12, label: '12 mois' },
  { months: 24, label: '24 mois' },
  { months: 36, label: '36 mois' },
];

export const PREDEFINED_CONTRACT_KINDS: readonly { systemKey: string; label: string; prefix: string }[] = [
  { systemKey: 'HORS_MAINTENANCE', label: 'Hors maintenance', prefix: 'HM' },
  { systemKey: 'MAINTENANCE', label: 'Maintenance', prefix: 'MNT' },
  { systemKey: 'MICROSOFT_365', label: 'Microsoft 365', prefix: 'M365' },
  { systemKey: 'NEXTCLOUD', label: 'Nextcloud', prefix: 'NXC' },
  { systemKey: 'TELEPHONIE_IP', label: 'Téléphonie IP', prefix: 'TIP' },
  { systemKey: 'DPO_EXTERNALISE', label: 'DPO externalisé', prefix: 'DPO' },
  { systemKey: 'RSSI', label: 'RSSI', prefix: 'RSSI' },
];

export interface SeedContractKindsResult {
  readonly tenantId: string;
  readonly termsCreated: number[];
  readonly kindsCreated: string[];
  readonly kindsKept: string[];
  /** Préfixe proposé déjà pris par un autre type : non créés. */
  readonly kindsBlocked: string[];
}

export async function seedContractKinds(
  db: PrismaClient,
  { slug = process.env.SEED_TENANT_SLUG ?? 'lsi', now = new Date() }: { slug?: string; now?: Date } = {},
): Promise<SeedContractKindsResult> {
  const tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error(`Tenant « ${slug} » introuvable.`);
  const tenantId = tenant.id;

  const termsCreated: number[] = [];
  for (const t of DEFAULT_COMMITMENT_TERMS) {
    const r = await db.commitmentTerm.createMany({
      data: [{ id: uuidv7(), tenantId, months: t.months, label: t.label, createdAt: now, updatedAt: now }],
      skipDuplicates: true,
    });
    if (r.count) termsCreated.push(t.months);
  }

  const kindsCreated: string[] = [];
  const kindsKept: string[] = [];
  const kindsBlocked: string[] = [];
  for (const [i, k] of PREDEFINED_CONTRACT_KINDS.entries()) {
    const existing = await db.contractKind.findUnique({ where: { tenantId_systemKey: { tenantId, systemKey: k.systemKey } } });
    if (existing) { kindsKept.push(k.label); continue; }
    const taken = await db.contractKind.findUnique({ where: { tenantId_prefix: { tenantId, prefix: k.prefix } } });
    if (taken) { kindsBlocked.push(`${k.label} (préfixe ${k.prefix} pris par « ${taken.label} »)`); continue; }
    await db.contractKind.create({
      data: {
        id: uuidv7(), tenantId, systemKey: k.systemKey, isSystem: true, prefix: k.prefix, label: k.label,
        sortOrder: (i + 1) * 10, createdAt: now, updatedAt: now,
      },
    });
    kindsCreated.push(k.label);
  }
  return { tenantId, termsCreated, kindsCreated, kindsKept, kindsBlocked };
}

async function main() {
  const db = createPrismaClient(process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL);
  try {
    const r = await seedContractKinds(db);
    console.log(`✔ Durées d'engagement créées : ${r.termsCreated.map((m) => `${m} mois`).join(', ') || 'aucune'}.`);
    console.log(`✔ Types de contrats créés : ${r.kindsCreated.join(', ') || 'aucun'}.`);
    if (r.kindsKept.length) console.log(`  Déjà présents, non modifiés : ${r.kindsKept.join(', ')}.`);
    if (r.kindsBlocked.length) console.log(`⚠ Non créés : ${r.kindsBlocked.join(' ; ')}.`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /contract-kinds\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
