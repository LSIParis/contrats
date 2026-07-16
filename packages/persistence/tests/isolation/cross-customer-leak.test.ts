import { describe, test, expect, beforeAll } from 'vitest';
import { withScope } from '../../src/scoped-client.js';
import { internalScope, adminScope, clientScope } from '../../src/scope.js';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { uuidv7 } from '../../src/uuid.js';

let fx: Fixture;

beforeAll(async () => {
  await applyMigrations();
  fx = await seedTwoCustomers();
});

describe('fuite inter-customer', () => {
  test('le scope du client A ne voit pas le contrat du client B', async () => {
    const rows = await withScope(internalScope(fx.tenantId, [fx.customerA.id]), (tx) =>
      tx.contract.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.customerA.contractId]);
  });

  test('un findUnique sur le contrat de B depuis le scope de A renvoie null (→ 404, pas 403)', async () => {
    // RM-30 : la ligne n'existe pas pour cette session. Le service lèvera
    // NotFound. Le comportement sûr est le comportement par défaut.
    const row = await withScope(internalScope(fx.tenantId, [fx.customerA.id]), (tx) =>
      tx.contract.findUnique({ where: { id: fx.customerB.contractId } }),
    );
    expect(row).toBeNull();
  });

  test('un admin (allCustomers) voit les deux clients', async () => {
    const rows = await withScope(adminScope(fx.tenantId), (tx) => tx.contract.findMany());
    expect(rows).toHaveLength(2);
  });

  test('un scope sur un tenant inconnu ne voit rien', async () => {
    const rows = await withScope(adminScope(uuidv7()), (tx) => tx.contract.findMany());
    expect(rows).toHaveLength(0);
  });
});

describe('WITH CHECK — on ne peut pas ÉCRIRE hors de son scope', () => {
  test('INSERT d’un contrat chez un client hors scope est rejeté', async () => {
    await expect(
      withScope(internalScope(fx.tenantId, [fx.customerA.id]), (tx) =>
        tx.contract.create({
          data: {
            id: uuidv7(),
            tenantId: fx.tenantId,
            customerId: fx.customerB.id, // ← hors scope
            reference: 'LSI-2026-9999',
            title: 'Contrat injecté',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test('UPDATE déplaçant un contrat vers un autre client est rejeté', async () => {
    // Sans WITH CHECK, ceci passerait : on lirait son scope mais on écrirait
    // dans celui d'un autre. C'est l'oubli classique des implémentations RLS.
    await expect(
      withScope(adminScope(fx.tenantId), (tx) =>
        tx.contract.update({
          where: { id: fx.customerA.contractId },
          data: { customerId: fx.customerB.id },
        }),
      ),
    ).resolves.toBeDefined(); // un admin a les deux clients dans son scope

    // Remise en état
    await withScope(adminScope(fx.tenantId), (tx) =>
      tx.contract.update({
        where: { id: fx.customerA.contractId },
        data: { customerId: fx.customerA.id },
      }),
    );

    // Mais un account manager restreint à A ne peut PAS l'envoyer chez B
    await expect(
      withScope(internalScope(fx.tenantId, [fx.customerA.id]), (tx) =>
        tx.contract.update({
          where: { id: fx.customerA.contractId },
          data: { customerId: fx.customerB.id },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('cloison de visibilité des commentaires (§6.10)', () => {
  test('un CLIENT ne voit pas un commentaire INTERNAL de son propre client', async () => {
    await withScope(adminScope(fx.tenantId), (tx) =>
      tx.comment.create({
        data: {
          id: uuidv7(),
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId: fx.customerA.contractId,
          visibility: 'INTERNAL',
          body: 'Marge à 32 %, on peut descendre à 28 % si blocage.',
          createdAt: new Date(),
        },
      }),
    );

    const seen = await withScope(clientScope(fx.tenantId, fx.customerA.id, uuidv7()), (tx) =>
      tx.comment.findMany(),
    );
    expect(seen).toHaveLength(0);
  });

  test('un CLIENT ne peut pas ÉCRIRE un commentaire INTERNAL', async () => {
    await expect(
      withScope(clientScope(fx.tenantId, fx.customerA.id, uuidv7()), (tx) =>
        tx.comment.create({
          data: {
            id: uuidv7(),
            tenantId: fx.tenantId,
            customerId: fx.customerA.id,
            contractId: fx.customerA.contractId,
            visibility: 'INTERNAL',
            body: 'tentative',
            createdAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  test('un CLIENT voit bien les commentaires SHARED', async () => {
    await withScope(adminScope(fx.tenantId), (tx) =>
      tx.comment.create({
        data: {
          id: uuidv7(),
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId: fx.customerA.contractId,
          visibility: 'SHARED',
          body: 'Bonjour, voici le contrat.',
          createdAt: new Date(),
        },
      }),
    );

    const seen = await withScope(clientScope(fx.tenantId, fx.customerA.id, uuidv7()), (tx) =>
      tx.comment.findMany(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.visibility).toBe('SHARED');
  });
});

describe('R12 — pas de GUC résiduel entre transactions', () => {
  /**
   * LA fuite la plus grave possible : une connexion recyclée du pool qui
   * conserverait le scope de l'utilisateur précédent. Silencieuse,
   * intermittente, visible seulement sous charge en production.
   *
   * C'est le test qui valide le 3e argument de set_config(..., true).
   */
  test('le scope ne survit pas au commit', async () => {
    await withScope(adminScope(fx.tenantId), (tx) => tx.contract.findMany());

    // Même connexion, très probablement. Sans portée transactionnelle,
    // les GUC de l'admin seraient encore là et ceci renverrait des lignes.
    //
    // NB : après un set_config(..., true), le GUC retombe à la chaîne vide
    // (pas à « inconnu »). C'est pourquoi les prédicats refusent
    // explicitement la chaîne vide — sans quoi la garantie dépendrait
    // d'un échec de cast (migration 00000000000003_fail_closed).
    const { unsafeUnscopedClient } = await import('../../src/scoped-client.js');
    await expect(unsafeUnscopedClient.contract.findMany()).rejects.toThrow(
      /scope absent[\s\S]*withScope/i,
    );
  });

  test('deux scopes successifs ne se contaminent pas', async () => {
    const a = await withScope(internalScope(fx.tenantId, [fx.customerA.id]), (tx) =>
      tx.contract.findMany(),
    );
    const b = await withScope(internalScope(fx.tenantId, [fx.customerB.id]), (tx) =>
      tx.contract.findMany(),
    );
    expect(a.map((r) => r.id)).toEqual([fx.customerA.contractId]);
    expect(b.map((r) => r.id)).toEqual([fx.customerB.contractId]);
  });
});
