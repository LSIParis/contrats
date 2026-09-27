/**
 * Jeu de données de DÉMONSTRATION (`pnpm seed`) — brief §15.
 *
 * Idempotent : relancer ne duplique rien (clés naturelles : slug du tenant,
 * code de clause, nom de modèle, référence externe du client). Tout ce qui
 * est créé est marqué démonstration (`is_demo`, clients « Démo — … »,
 * SIREN fictifs) pour ne jamais être confondu avec des données réelles.
 *
 * Connexion : rôle PROPRIÉTAIRE du schéma (celui des migrations), via
 * `SEED_DATABASE_URL`, sinon `DATABASE_URL`. Refus en production sans
 * `SEED_ALLOW_PRODUCTION=1` explicite.
 *
 *   SEED_TENANT_SLUG=lsi pnpm seed
 */
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../uuid.js';

const SLUG = process.env.SEED_TENANT_SLUG ?? 'lsi';

export const DEMO_CLAUSES: readonly { code: string; category: string; title: string; bodyHtml: string }[] = [
  {
    code: 'DEMO-OBJET', category: 'OBJET', title: 'Objet',
    bodyHtml: '<p>Le présent contrat a pour objet de définir les conditions dans lesquelles {{prestataire.raisonSociale}} assure la maintenance du système d’information de {{client.raisonSociale}}, tel que décrit en annexe.</p>',
  },
  {
    code: 'DEMO-DUREE', category: 'DUREE', title: 'Durée et reconduction',
    bodyHtml: '<p>Le contrat prend effet le {{contrat.dateEffet}} pour une durée initiale de {{contrat.dureeMois}} mois. {{contrat.reconduction}}. Chaque partie peut le dénoncer moyennant un préavis de {{contrat.preavis}} avant le terme de la période en cours.</p>',
  },
  {
    code: 'DEMO-PRIX', category: 'PRIX', title: 'Prix et révision',
    bodyHtml: '<p>En contrepartie des prestations, le Client verse une redevance mensuelle de {{tarif.montantMensuelHt}} € HT, révisée chaque année selon la formule définie en annexe tarifaire.</p>',
  },
  {
    code: 'DEMO-SLA', category: 'SLA', title: 'Niveaux de service',
    bodyHtml: '<p>Le Prestataire intervient dans un délai de {{sla.delaiIntervention}} pendant la plage {{sla.plageHoraire}}, et s’engage à un délai de rétablissement de {{sla.delaiRetablissement}}.</p>',
  },
  {
    code: 'DEMO-RESPONSABILITE', category: 'RESPONSABILITE', title: 'Responsabilité',
    bodyHtml: '<p>La responsabilité du Prestataire, toutes causes confondues, est limitée au montant des sommes versées au titre des douze derniers mois, sauf faute lourde ou dolosive.</p>',
  },
  {
    code: 'DEMO-RGPD', category: 'RGPD', title: 'Données personnelles',
    bodyHtml: '<p>Lorsqu’il traite des données personnelles pour le compte du Client, le Prestataire agit en qualité de sous-traitant au sens de l’article 28 du RGPD, dans les conditions de l’accord de traitement annexé.</p>',
  },
  {
    code: 'DEMO-CONFIDENTIALITE', category: 'CONFIDENTIALITE', title: 'Confidentialité',
    bodyHtml: '<p>Chaque partie s’engage à garder confidentielles les informations reçues de l’autre partie pendant la durée du contrat et cinq ans après son terme.</p>',
  },
  {
    code: 'DEMO-RESILIATION', category: 'RESILIATION', title: 'Résiliation',
    bodyHtml: '<p>En cas de manquement grave non réparé dans les trente jours d’une mise en demeure, l’autre partie peut résilier le contrat de plein droit par lettre recommandée avec accusé de réception.</p>',
  },
];

const DEMO_CUSTOMERS = [
  { ref: 'DEMO-001', name: 'Démo — Boulangerie des Tilleuls', siren: '000000001', city: 'Paris' },
  { ref: 'DEMO-002', name: 'Démo — Cabinet Ardoise Expertise', siren: '000000002', city: 'Lyon' },
  { ref: 'DEMO-003', name: 'Démo — Atelier Mécanique du Val', siren: '000000003', city: 'Nantes' },
] as const;

const TEMPLATE_NAME = 'Contrat de maintenance informatique (démonstration)';

export async function seedDemo(db: PrismaClient, { slug = SLUG, now = new Date() }: { slug?: string; now?: Date } = {}) {
  let tenant = await db.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    tenant = await db.tenant.create({ data: { id: uuidv7(), name: 'LSI Maintenance', slug, createdAt: now, updatedAt: now } });
  }
  const tenantId = tenant.id;

  for (const c of DEMO_CUSTOMERS) {
    const found = await db.customer.findFirst({ where: { tenantId, externalRef: c.ref } });
    if (!found) {
      await db.customer.create({ data: {
        id: uuidv7(), tenantId, name: c.name, siren: c.siren, city: c.city, country: 'FR', externalRef: c.ref,
        notes: 'Client de démonstration (pnpm seed) — données fictives.', createdAt: now, updatedAt: now,
      } });
    }
  }

  const versionIds: string[] = [];
  for (const cl of DEMO_CLAUSES) {
    let item = await db.clauseLibraryItem.findUnique({ where: { tenantId_code: { tenantId, code: cl.code } } });
    if (!item) {
      item = await db.$transaction(async (tx) => {
        const itemId = uuidv7();
        const versionId = uuidv7();
        await tx.clauseLibraryItem.create({ data: {
          id: itemId, tenantId, code: cl.code, category: cl.category as never, title: cl.title, isDemo: true, createdAt: now, updatedAt: now,
        } });
        await tx.clauseLibraryItemVersion.create({ data: {
          id: versionId, tenantId, itemId, versionNumber: 1, bodyHtml: cl.bodyHtml,
          variables: [...cl.bodyHtml.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!), changeNote: 'Démonstration', createdAt: now,
        } });
        return tx.clauseLibraryItem.update({ where: { id: itemId }, data: { currentVersionId: versionId } });
      });
    }
    versionIds.push(item.currentVersionId!);
  }

  const existing = await db.contractTemplate.findFirst({ where: { tenantId, name: TEMPLATE_NAME } });
  // Tout ou rien : un modèle publié sans ses clauses serait pire qu'aucun modèle.
  if (!existing) await db.$transaction(async (tx) => {
    const templateId = uuidv7();
    const versionId = uuidv7();
    const names = [...new Set(DEMO_CLAUSES.flatMap((c) => [...c.bodyHtml.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!)))].sort();
    const properties = Object.fromEntries(names.map((n) => [n, { type: 'string' }]));
    await tx.contractTemplate.create({ data: {
      id: templateId, tenantId, name: TEMPLATE_NAME, category: 'MAINTENANCE', status: 'PUBLISHED', isDemo: true, createdAt: now, updatedAt: now,
    } });
    await tx.contractTemplateVersion.create({ data: {
      id: versionId, tenantId, templateId, versionNumber: 1, bodyHtml: '',
      variablesSchema: { type: 'object', properties, required: names }, isImmutable: true, publishedAt: now, createdAt: now,
      defaultAnnexes: [{ kind: 'SLA', title: 'Annexe 1 — Niveaux de service', bodyHtml: '<p>Tableau des niveaux de service (démonstration).</p>' }],
    } });
    await tx.templateClause.createMany({
      data: versionIds.map((clauseVersionId, i) => ({ tenantId, templateVersionId: versionId, position: i + 1, clauseVersionId, required: i < 2 })),
    });
    await tx.contractTemplate.update({ where: { id: templateId }, data: { currentVersionId: versionId } });
  });

  return {
    tenantId,
    customers: await db.customer.count({ where: { tenantId, externalRef: { startsWith: 'DEMO-' } } }),
    clauses: await db.clauseLibraryItem.count({ where: { tenantId, isDemo: true } }),
    templates: await db.contractTemplate.count({ where: { tenantId, isDemo: true } }),
  };
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    console.error('✖ Refus : NODE_ENV=production. Positionnez SEED_ALLOW_PRODUCTION=1 si c’est voulu.');
    process.exit(2);
  }
  const db = new PrismaClient({ datasourceUrl: process.env.SEED_DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const r = await seedDemo(db);
    console.log(`✔ Démonstration prête pour le tenant « ${SLUG} » : ${r.customers} clients, ${r.clauses} clauses, ${r.templates} modèle(s).`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /demo\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
