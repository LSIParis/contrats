import { createHash } from 'node:crypto';
import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import {
  withScope, internalScope, adminScope, clientScope, systemScope, tenantSystemScope, proposalLinkScope,
  resolveProposalLink, nextProposalSequence, purgeProposalViewEvents, setTransitionContext,
  findProposalsToExpire,
} from '../../src/index.js';
import { uuidv7 } from '../../src/uuid.js';

/**
 * Garanties de la migration 31 (propositions commerciales), testées EN BASE
 * sous le rôle applicatif lsi_app : cloisonnement tenant + client, page
 * publique confinée à UNE proposition et en lecture seule, journal des
 * transitions, immuabilité des versions envoyées, numérotation atomique.
 */
let owner: PrismaClient;
let fx: Fixture;
let fx2: Fixture;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
  fx2 = await seedTwoCustomers();
});

/** Proposition + version v1 + section + destinataire + lien, créés par l'AM de A. */
async function seedProposal(f: Fixture, customerId: string, token = uuidv7()) {
  const id = uuidv7();
  const versionId = uuidv7();
  const sectionId = uuidv7();
  const recipientId = uuidv7();
  const now = new Date();
  await withScope(adminScope(f.tenantId, f.adminUserId), async (tx) => {
    const n = await nextProposalSequence(tx, f.tenantId, 2026);
    await tx.proposal.create({
      data: {
        id, tenantId: f.tenantId, customerId, number: `PROP-2026-${String(n).padStart(4, '0')}`, title: 'Infogérance',
        ownerUserId: f.amUserId, currentVersionId: versionId, createdAt: now, updatedAt: now,
        createdByUserId: f.adminUserId, updatedByUserId: f.adminUserId,
      },
    });
    await tx.proposalVersion.create({
      data: {
        id: versionId, tenantId: f.tenantId, customerId, proposalId: id, versionNumber: 1, title: 'v1',
        pricingDefinition: { choices: [], lines: [], rules: [], vatRatePercent: 20 }, createdAt: now,
        createdByUserId: f.adminUserId,
      },
    });
    await tx.proposalSection.create({
      data: { id: sectionId, tenantId: f.tenantId, customerId, proposalId: id, versionId, position: 0, key: 'contexte', title: 'Contexte', kind: 'TEXT' },
    });
    await tx.proposalRecipient.create({
      data: {
        id: recipientId, tenantId: f.tenantId, customerId, proposalId: id, fullName: 'Jeanne Client',
        email: `jeanne-${id.slice(-8)}@client.fr`, role: 'SIGNER', createdAt: now, updatedAt: now,
      },
    });
    await tx.proposalAccessLink.create({
      data: {
        id: uuidv7(), tenantId: f.tenantId, customerId, proposalId: id, versionId, recipientId,
        tokenHash: sha(token), expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now,
      },
    });
  });
  return { id, versionId, sectionId, recipientId, token };
}

describe('RLS — classe « tenant » (modèles, bibliothèque)', () => {
  test('lisibles par l’interne du tenant, jamais par un client ni par un autre tenant', async () => {
    const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contentLibraryItem.create({
        data: { id: uuidv7(), tenantId: fx.tenantId, key: 'qui-sommes-nous', title: 'Qui sommes-nous', folder: 'commun', body: 'LSI-Maintenance…', createdAt: now, updatedAt: now },
      }),
    );
    const mine = await withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), (tx) => tx.contentLibraryItem.count());
    expect(mine).toBe(1);
    const client = await withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
      tx.contentLibraryItem.count(),
    );
    expect(client).toBe(0);
    const other = await withScope(adminScope(fx2.tenantId, fx2.adminUserId), (tx) => tx.contentLibraryItem.count());
    expect(other).toBe(0);
  });
});

describe('RLS — propositions (classe « customer »)', () => {
  test('portefeuille : l’AM de A voit la proposition de A, pas celle de B ; le portail client ne voit rien', async () => {
    const pA = await seedProposal(fx, fx.customerA.id);
    const pB = await seedProposal(fx, fx.customerB.id);
    const am = internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId);
    const ids = await withScope(am, (tx) => tx.proposal.findMany({ select: { id: true } }));
    expect(ids.map((r) => r.id)).toContain(pA.id);
    expect(ids.map((r) => r.id)).not.toContain(pB.id);
    const portal = await withScope(clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId), (tx) =>
      tx.proposal.findMany(),
    );
    expect(portal).toEqual([]);
    const otherTenant = await withScope(adminScope(fx2.tenantId, fx2.adminUserId), (tx) => tx.proposal.findMany());
    expect(otherTenant.map((r) => r.id)).not.toContain(pA.id);
  });

  test('lien public : lecture confinée à SA proposition (pas une autre du même client) et aucune écriture', async () => {
    const p1 = await seedProposal(fx, fx.customerA.id);
    const p2 = await seedProposal(fx, fx.customerA.id);
    const link = await resolveProposalLink(sha(p1.token));
    expect(link).toMatchObject({ tenantId: fx.tenantId, customerId: fx.customerA.id, proposalId: p1.id, versionId: p1.versionId });
    expect(await resolveProposalLink(sha('jeton-inconnu'))).toBeNull();
    expect(await resolveProposalLink('pas-un-hash')).toBeNull();

    const scope = proposalLinkScope(link!.tenantId, link!.proposalId);
    const seen = await withScope(scope, async (tx) => ({
      proposals: await tx.proposal.findMany({ select: { id: true } }),
      versions: await tx.proposalVersion.findMany({ select: { proposalId: true } }),
      sections: await tx.proposalSection.findMany({ select: { proposalId: true } }),
      recipients: await tx.proposalRecipient.findMany({ select: { proposalId: true } }),
      contracts: await tx.contract.findMany(),
      customers: await tx.customer.findMany(),
      links: await tx.proposalAccessLink.findMany(),
      templates: await tx.proposalTemplate.findMany(),
    }));
    expect(seen.proposals.map((r) => r.id)).toEqual([p1.id]);
    expect(new Set(seen.versions.map((r) => r.proposalId))).toEqual(new Set([p1.id]));
    expect(new Set(seen.sections.map((r) => r.proposalId))).toEqual(new Set([p1.id]));
    expect(new Set(seen.recipients.map((r) => r.proposalId))).toEqual(new Set([p1.id]));
    expect(seen.contracts).toEqual([]);
    expect(seen.customers).toEqual([]);
    expect(seen.links).toEqual([]);
    expect(seen.templates).toEqual([]);
    expect(seen.proposals.map((r) => r.id)).not.toContain(p2.id);

    // Aucune écriture : ni mise à jour, ni insertion, ni suppression.
    const updated = await withScope(scope, (tx) => tx.proposal.updateMany({ where: { id: p1.id }, data: { title: 'piraté' } }));
    expect(updated.count).toBe(0);
    const deleted = await withScope(scope, (tx) => tx.proposalRecipient.deleteMany({ where: { proposalId: p1.id } }));
    expect(deleted.count).toBe(0);
    await expect(
      withScope(scope, (tx) =>
        tx.proposalComment.create({
          data: {
            id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, proposalId: p1.id, versionId: p1.versionId,
            authorKind: 'CLIENT', recipientId: p1.recipientId, authorName: 'x', body: 'x', createdAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  test('un lien d’un autre tenant ne s’ouvre pas sur ce tenant', async () => {
    const p = await seedProposal(fx2, fx2.customerA.id);
    const link = await resolveProposalLink(sha(p.token));
    // Même en forgeant un scope de lien sur le tenant de fx, la proposition de fx2 reste invisible.
    const seen = await withScope(proposalLinkScope(fx.tenantId, link!.proposalId), (tx) => tx.proposal.findMany());
    expect(seen).toEqual([]);
  });
});

describe('journal, immuabilité, numérotation', () => {
  test('toute transition est journalisée par trigger, avec événement et motif', async () => {
    const p = await seedProposal(fx, fx.customerA.id);
    await withScope(internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId), async (tx) => {
      await setTransitionContext(tx, { event: 'MARK_READY', reason: 'Prête' });
      await tx.proposal.update({ where: { id: p.id }, data: { status: 'READY' } });
    });
    const events = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposalLifecycleEvent.findMany({ where: { proposalId: p.id }, orderBy: { seq: 'asc' } }),
    );
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.event])).toEqual([
      [null, 'DRAFT', null],
      ['DRAFT', 'READY', 'MARK_READY'],
    ]);
    expect(events[1]!.actorUserId).toBe(fx.amUserId);
    const audit = await owner.auditLog.findFirst({ where: { tenantId: fx.tenantId, resourceId: p.id, action: 'proposal.transition' }, orderBy: { seq: 'desc' } });
    expect(audit?.after).toMatchObject({ from: 'DRAFT', to: 'READY', event: 'MARK_READY' });
    // Le rôle applicatif ne peut pas écrire le journal à la main.
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.proposalLifecycleEvent.create({
          data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, proposalId: p.id, toStatus: 'SIGNED', actorKind: 'SYSTEM', occurredAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  test('une version envoyée est figée (contenu, structure), seuls le PDF et le remplacement se posent une fois', async () => {
    const p = await seedProposal(fx, fx.customerA.id);
    const admin = adminScope(fx.tenantId, fx.adminUserId);
    await withScope(admin, (tx) => tx.proposalVersion.update({ where: { id: p.versionId }, data: { lockedAt: new Date() } }));
    await expect(
      withScope(admin, (tx) => tx.proposalVersion.update({ where: { id: p.versionId }, data: { title: 'modifié' } })),
    ).rejects.toThrow(/immuable/);
    await expect(
      withScope(admin, (tx) => tx.proposalSection.update({ where: { id: p.sectionId }, data: { title: 'modifié' } })),
    ).rejects.toThrow(/figée/);
    await withScope(admin, (tx) =>
      tx.proposalVersion.update({ where: { id: p.versionId }, data: { pdfSha256: 'a'.repeat(64), pdfObjectKey: 'k', supersededAt: new Date() } }),
    );
    await expect(
      withScope(admin, (tx) => tx.proposalVersion.update({ where: { id: p.versionId }, data: { pdfSha256: 'b'.repeat(64) } })),
    ).rejects.toThrow(/immuable/);
    await expect(withScope(admin, (tx) => tx.proposalVersion.delete({ where: { id: p.versionId } }))).rejects.toThrow();
  });

  test('numérotation atomique par tenant et par année', async () => {
    const admin = adminScope(fx2.tenantId, fx2.adminUserId);
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => withScope(admin, (tx) => nextProposalSequence(tx, fx2.tenantId, 2031))));
    expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(await withScope(admin, (tx) => nextProposalSequence(tx, fx2.tenantId, 2032))).toBe(1);
  });

  test('un contrat ne peut provenir que d’une seule proposition, et réciproquement une proposition ne crée qu’un contrat', async () => {
    const p = await seedProposal(fx, fx.customerA.id);
    const admin = adminScope(fx.tenantId, fx.adminUserId);
    await withScope(admin, (tx) => tx.contract.update({ where: { id: fx.customerA.contractId }, data: { proposalId: p.id } }));
    const second = uuidv7();
    await owner.$executeRaw`INSERT INTO contracts (id, tenant_id, customer_id, reference, title, type, status, category, currency,
      billing_frequency, owner_user_id, created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES (${second}::uuid, ${fx.tenantId}::uuid, ${fx.customerA.id}::uuid, ${'P-' + second.slice(-12)}, 'bis', 'MAIN', 'DRAFT', 'MAINTENANCE',
      'EUR', 'MONTHLY', ${fx.amUserId}::uuid, now(), now(), ${fx.amUserId}::uuid, ${fx.amUserId}::uuid)`;
    await expect(
      withScope(admin, (tx) => tx.contract.update({ where: { id: second }, data: { proposalId: p.id } })),
    ).rejects.toThrow();
    // Une proposition du client B ne peut pas être rattachée à un contrat du client A (FK composite).
    const pB = await seedProposal(fx, fx.customerB.id);
    await expect(
      withScope(admin, (tx) => tx.contract.update({ where: { id: second }, data: { proposalId: pB.id } })),
    ).rejects.toThrow();
  });
});

describe('découverte et purge (jobs)', () => {
  test('expiration : identifiants seulement, statuts ouverts et échéance passée', async () => {
    const p = await seedProposal(fx, fx.customerA.id);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.proposal.update({ where: { id: p.id }, data: { status: 'SENT', expiresAt: new Date(Date.now() - 60_000) } }),
    );
    const refs = await findProposalsToExpire();
    expect(refs).toContainEqual({ id: p.id, tenantId: fx.tenantId, customerId: fx.customerA.id });
  });

  test('purge du suivi détaillé : bornée au tenant de la transaction', async () => {
    await expect(
      withScope(tenantSystemScope(fx.tenantId), (tx) => purgeProposalViewEvents(tx, fx2.tenantId, 30)),
    ).rejects.toThrow(/hors tenant/);
    const p = await seedProposal(fx, fx.customerA.id);
    const old = new Date(Date.now() - 400 * 86_400_000);
    await withScope(systemScope(fx.tenantId, fx.customerA.id), async (tx) => {
      await tx.proposal.update({ where: { id: p.id }, data: { status: 'DECLINED', declineReasonCode: 'PRICE', declinedAt: old } });
      await tx.proposalViewEvent.create({
        data: { id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, proposalId: p.id, versionId: p.versionId, kind: 'OPENED', occurredAt: old },
      });
    });
    const n = await withScope(tenantSystemScope(fx.tenantId), (tx) => purgeProposalViewEvents(tx, fx.tenantId, 365));
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.proposalViewEvent.count({ where: { proposalId: p.id } }));
    expect(left).toBe(0);
  });
});
