import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { withScope } from '../../src/scoped-client.js';
import { internalScope } from '../../src/scope.js';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';

let app: PrismaClient;
let fx: Fixture;

beforeAll(async () => {
  await applyMigrations();
  app = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_APP });
  fx = await seedTwoCustomers();
});

describe('withScope — le scope est obligatoire', () => {
  /**
   * LE test du dossier (§10.3, §16.4-C, R12).
   *
   * Une requête sans scope ne doit PAS renvoyer zéro ligne : elle doit
   * PLANTER. Zéro ligne est un bug qui passe la revue et se réveille en
   * production ; une exception casse le test à la première exécution.
   */
  test('une requête hors withScope lève une exception, et ne renvoie pas zéro ligne', async () => {
    // Refus EXPLICITE des prédicats (migration 00000000000003_fail_closed),
    // et non un échec de cast incident : le message est stable et diagnostique.
    //
    // On n'assertionne pas QUEL GUC est nommé : cela dépend de l'ordre
    // d'évaluation du planificateur, un détail interne.
    await expect(app.contract.findMany()).rejects.toThrow(
      /scope absent[\s\S]*withScope/i,
    );
  });

  test('un findMany hors scope ne renvoie JAMAIS de lignes, même en cas d’erreur avalée', async () => {
    // Formulation complémentaire : si un jour quelqu'un « corrige » RLS avec
    // missing_ok=true, le test ci-dessus casserait mais celui-ci dirait
    // pourquoi c'est grave — des lignes traverseraient.
    let rows: unknown[] | undefined;
    try {
      rows = await app.contract.findMany();
    } catch {
      rows = undefined;
    }
    expect(rows).toBeUndefined();
  });

  test('la même requête dans withScope réussit', async () => {
    const rows = await withScope(internalScope(fx.tenantId, [fx.customerA.id]), (tx) =>
      tx.contract.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(fx.customerA.contractId);
  });
});
