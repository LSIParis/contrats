import { describe, test, expect, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { withScope } from '../../src/scoped-client.js';
import { adminScope } from '../../src/scope.js';
import { applyMigrations, seedTwoCustomers, type Fixture } from '../support/fixtures.js';
import { uuidv7 } from '../../src/uuid.js';

let owner: PrismaClient;
let fx: Fixture;

beforeAll(async () => {
  await applyMigrations();
  owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  fx = await seedTwoCustomers();
});

/**
 * Les règles métier traduites en contraintes de base.
 *
 * Chacune pourrait vivre dans un service. Elle vivrait alors dans UN service,
 * et le prochain chemin d'écriture (job, script de reprise, migration de
 * données) l'ignorerait. Ces tests vérifient qu'elles sont vraies pour tout
 * le monde — y compris pour le propriétaire de la base.
 */
describe('RM-32 — aucun compte hybride INTERNAL + CLIENT', () => {
  test('un utilisateur INTERNAL avec un customer_id est rejeté', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
        VALUES ('${uuidv7()}', '${fx.tenantId}', 'INTERNAL', '${fx.customerA.id}',
                'hybride-${uuidv7().slice(-12)}@lsi.fr', 'Compte hybride', 'ACTIVE', now(), now())
      `),
    ).rejects.toThrow(/users_kind_customer_coherence/i);
  });

  test('un utilisateur CLIENT sans customer_id est rejeté', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO users (id, tenant_id, kind, customer_id, email, full_name, status, created_at, updated_at)
        VALUES ('${uuidv7()}', '${fx.tenantId}', 'CLIENT', NULL,
                'orphelin-${uuidv7().slice(-12)}@x.fr', 'Client orphelin', 'ACTIVE', now(), now())
      `),
    ).rejects.toThrow(/users_kind_customer_coherence/i);
  });
});

describe('RM-10 — séparation des tâches sur la validation', () => {
  test('le même utilisateur ne peut pas soumettre ET valider', async () => {
    // Sans cette contrainte, la validation interne est un théâtre.
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO contract_approvals (id, tenant_id, customer_id, contract_id, version_id,
                                        submitted_by_user_id, decided_by_user_id, decision, submitted_at)
        VALUES ('${uuidv7()}', '${fx.tenantId}', '${fx.customerA.id}', '${fx.customerA.contractId}',
                '${uuidv7()}', '${fx.amUserId}', '${fx.amUserId}', 'APPROVED', now())
      `),
    ).rejects.toThrow(/approvals_separation_of_duties/i);
  });

  test('deux utilisateurs distincts sont acceptés', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO contract_approvals (id, tenant_id, customer_id, contract_id, version_id,
                                        submitted_by_user_id, decided_by_user_id, decision, submitted_at)
        VALUES ('${uuidv7()}', '${fx.tenantId}', '${fx.customerA.id}', '${fx.customerA.contractId}',
                '${uuidv7()}', '${fx.amUserId}', '${fx.adminUserId}', 'APPROVED', now())
      `),
    ).resolves.toBeDefined();
  });
});

describe('RM-08 — cohérence des dates et montants', () => {
  test('start_date > end_date est rejeté', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        UPDATE contracts SET start_date = '2027-01-01', end_date = '2026-01-01'
        WHERE id = '${fx.customerA.contractId}'
      `),
    ).rejects.toThrow(/contracts_date_order/i);
  });

  test('un montant négatif est rejeté', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        UPDATE contracts SET amount_cents = -1 WHERE id = '${fx.customerA.contractId}'
      `),
    ).rejects.toThrow(/contracts_amount_non_negative/i);
  });

  test('un contrat MAIN avec un parent est rejeté', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        UPDATE contracts SET parent_contract_id = '${fx.customerB.contractId}'
        WHERE id = '${fx.customerA.contractId}'
      `),
    ).rejects.toThrow(/contracts_amendment_has_parent/i);
  });
});

describe('RM-05 — immuabilité du contenu, écriture unique de l’empreinte', () => {
  async function seedVersion(): Promise<string> {
    const id = uuidv7();
    await owner.$executeRawUnsafe(`
      INSERT INTO contract_versions (id, tenant_id, customer_id, contract_id, version_number,
                                     body_html, variables, created_at, created_by_user_id)
      VALUES ('${id}', '${fx.tenantId}', '${fx.customerA.id}', '${fx.customerA.contractId}',
              ${Math.floor(Math.random() * 100000)}, '<h1>Contrat</h1>', '{}'::jsonb, now(), '${fx.amUserId}')
    `);
    return id;
  }

  test('le CONTENU d’une version ne peut pas être modifié', async () => {
    // Un contrat signé est immuable définitivement, y compris pour MSP_ADMIN.
    // Ce n'est pas une question de rôle applicatif : c'est la valeur probante.
    const id = await seedVersion();
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$executeRawUnsafe(`UPDATE contract_versions SET body_html = 'falsifié' WHERE id = '${id}'`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('l’empreinte peut être renseignée UNE fois', async () => {
    const id = await seedVersion();
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractVersion.update({
          where: { id },
          data: { pdfSha256: 'a'.repeat(64), pdfObjectKey: 'k1' },
        }),
      ),
    ).resolves.toBeDefined();
  });

  test('l’empreinte ne peut PAS être réécrite une fois posée', async () => {
    // C'est tout l'enjeu : un hash réécrivable ne prouve rien. On pourrait
    // le faire correspondre à un autre document que celui réellement envoyé.
    const id = await seedVersion();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractVersion.update({
        where: { id },
        data: { pdfSha256: 'a'.repeat(64), pdfObjectKey: 'k1' },
      }),
    );

    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractVersion.update({ where: { id }, data: { pdfSha256: 'b'.repeat(64) } }),
      ),
    ).rejects.toThrow(/écriture unique/i);
  });

  test('réécrire la même valeur est toléré (idempotence d’un réessai)', async () => {
    const id = await seedVersion();
    const hash = 'c'.repeat(64);
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractVersion.update({ where: { id }, data: { pdfSha256: hash, pdfObjectKey: 'k2' } }),
    );
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.contractVersion.update({ where: { id }, data: { pdfSha256: hash, pdfObjectKey: 'k2' } }),
      ),
    ).resolves.toBeDefined();
  });

  test('lsi_app ne peut pas DELETE contract_versions', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM contract_versions`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('§13.4 — journal d’audit append-only', () => {
  test('lsi_app ne peut pas UPDATE audit_logs', async () => {
    // Un journal qu'un administrateur applicatif peut réécrire n'est pas
    // un journal d'audit.
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$executeRawUnsafe(`UPDATE audit_logs SET action = 'falsifié'`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('lsi_app ne peut pas DELETE audit_logs', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM audit_logs`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('lsi_app PEUT insérer dans audit_logs', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.auditLog.create({
          data: {
            id: uuidv7(),
            tenantId: fx.tenantId,
            customerId: fx.customerA.id,
            actorUserId: fx.adminUserId,
            actorKind: 'INTERNAL',
            action: 'contract.viewed',
            resourceType: 'contract',
            resourceId: fx.customerA.contractId,
            occurredAt: new Date(),
            hash: 'a'.repeat(64),
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  test('lsi_app ne peut pas UPDATE signature_events', async () => {
    await expect(
      withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.$executeRawUnsafe(`UPDATE signature_events SET event_type = 'FORM_COMPLETED'`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('§12.3 — le rôle scheduler est borné', () => {
  test('lsi_scheduler existe, sans BYPASSRLS ni superuser', async () => {
    const [r] = await owner.$queryRawUnsafe<{ bypass: boolean; superuser: boolean }[]>(`
      SELECT rolbypassrls AS bypass, rolsuper AS superuser
      FROM pg_roles WHERE rolname = 'lsi_scheduler'
    `);
    expect(r).toBeDefined();
    expect(r!.bypass).toBe(false);
    expect(r!.superuser).toBe(false);
  });

  /**
   * On positionne un scope PLAUSIBLE avant chaque tentative.
   *
   * Sans cela, le test ne prouverait rien d'intéressant : le prédicat RLS
   * lèverait « scope absent » (évalué à la planification, avant le contrôle
   * de permission de table) et l'on croirait le rôle borné alors qu'on
   * n'aurait mesuré que l'absence de GUC.
   *
   * La vraie question est : le scheduler pourrait-il lire les contrats S'IL
   * positionnait un scope ? La réponse doit être non — parce que le GRANT
   * n'existe pas, indépendamment de RLS.
   */
  async function schedulerWithScope() {
    const uri = new URL(process.env.DATABASE_URL!);
    uri.username = 'lsi_scheduler';
    uri.password = 'lsi_scheduler_test_pwd';
    const sched = new PrismaClient({ datasourceUrl: uri.toString() });
    return sched;
  }

  async function asScheduler<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const sched = await schedulerWithScope();
    try {
      return await sched.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${fx.tenantId}', true)`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.all_customers', 'on', true)`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.actor_kind', 'SYSTEM', true)`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', 'system', true)`);
        return fn(tx);
      });
    } finally {
      await sched.$disconnect();
    }
  }

  test('lsi_scheduler ne peut PAS lire les contrats, MÊME avec un scope valide', async () => {
    // L'exception au cloisonnement doit être aussi étroite que sa raison
    // d'être : il découvre des identifiants de scope, il ne lit ni contrat,
    // ni contenu, ni adresse.
    await expect(asScheduler((tx) => tx.$queryRawUnsafe(`SELECT id FROM contracts LIMIT 1`))).rejects.toThrow(
      /permission denied/i,
    );
  });

  test('lsi_scheduler ne peut PAS lire les commentaires', async () => {
    await expect(asScheduler((tx) => tx.$queryRawUnsafe(`SELECT body FROM comments LIMIT 1`))).rejects.toThrow(
      /permission denied/i,
    );
  });

  test('lsi_scheduler ne peut PAS lire les adresses email', async () => {
    await expect(asScheduler((tx) => tx.$queryRawUnsafe(`SELECT email FROM users LIMIT 1`))).rejects.toThrow(
      /permission denied/i,
    );
  });

  test('lsi_scheduler ne peut pas lire les colonnes non accordées de reminders', async () => {
    await expect(
      asScheduler((tx) => tx.$queryRawUnsafe(`SELECT last_error FROM reminders`)),
    ).rejects.toThrow(/permission denied/i);
  });

  test('il existe EXACTEMENT deux rôles autorisés hors scope', async () => {
    // Le dossier n'en prévoyait qu'un ; l'implémentation du webhook a révélé
    // le second. Ce test fige le compte : un TROISIÈME rôle qui apparaîtrait
    // casse la CI et force à justifier l'exception.
    const rows = await owner.$queryRawUnsafe<{ rolname: string }[]>(`
      SELECT rolname FROM pg_roles
      WHERE rolname LIKE 'lsi_%' AND rolcanlogin
      ORDER BY rolname
    `);
    expect(rows.map((r) => r.rolname)).toEqual(['lsi_app', 'lsi_scheduler', 'lsi_webhook']);
  });

  test('lsi_scheduler PEUT découvrir les rappels dus — sa seule raison d’être', async () => {
    await expect(
      asScheduler((tx) =>
        tx.$queryRawUnsafe(
          `SELECT id, tenant_id, customer_id FROM reminders WHERE status = 'PENDING' AND due_at <= now()`,
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe('§11.4 — le rôle webhook est borné', () => {
  async function asWebhook<T>(fn: (c: PrismaClient) => Promise<T>): Promise<T> {
    const uri = new URL(process.env.DATABASE_URL!);
    uri.username = 'lsi_webhook';
    uri.password = 'lsi_webhook_test_pwd';
    const wh = new PrismaClient({ datasourceUrl: uri.toString() });
    try {
      return await fn(wh);
    } finally {
      await wh.$disconnect();
    }
  }

  test('lsi_webhook n’a NI BYPASSRLS NI superuser', async () => {
    const [r] = await owner.$queryRawUnsafe<{ bypass: boolean; superuser: boolean }[]>(`
      SELECT rolbypassrls AS bypass, rolsuper AS superuser
      FROM pg_roles WHERE rolname = 'lsi_webhook'
    `);
    expect(r).toBeDefined();
    expect(r!.bypass).toBe(false);
    expect(r!.superuser).toBe(false);
  });

  test('lsi_webhook PEUT résoudre le scope d’une submission — sa seule raison d’être', async () => {
    await expect(
      asWebhook((c) =>
        c.$queryRawUnsafe(
          `SELECT id, tenant_id, customer_id, contract_id FROM signature_requests
           WHERE provider = 'DOCUSEAL' AND provider_submission_id = 'x'`,
        ),
      ),
    ).resolves.toBeDefined();
  });

  test('lsi_webhook ne peut PAS lire le PDF signé ni les preuves', async () => {
    // L'exception ouvre la RÉSOLUTION DE SCOPE, pas la lecture des preuves.
    // Si ce rôle fuitait, l'attaquant apprendrait que des demandes de
    // signature existent — pas ce qu'elles contiennent.
    await expect(
      asWebhook((c) => c.$queryRawUnsafe(`SELECT signed_pdf_object_key FROM signature_requests`)),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asWebhook((c) => c.$queryRawUnsafe(`SELECT signed_pdf_sha256 FROM signature_requests`)),
    ).rejects.toThrow(/permission denied/i);
  });

  test('lsi_webhook ne peut lire AUCUNE autre table', async () => {
    await expect(asWebhook((c) => c.$queryRawUnsafe(`SELECT id FROM contracts`))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asWebhook((c) => c.$queryRawUnsafe(`SELECT body FROM comments`))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asWebhook((c) => c.$queryRawUnsafe(`SELECT email FROM users`))).rejects.toThrow(
      /permission denied/i,
    );
  });

  test('lsi_webhook ne peut RIEN écrire', async () => {
    // Le traitement de l'événement se fait ensuite sous lsi_app, DANS le
    // scope résolu. Ce rôle ne sert qu'à trouver le scope.
    await expect(
      asWebhook((c) =>
        c.$executeRawUnsafe(`UPDATE signature_requests SET status = 'COMPLETED'`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
