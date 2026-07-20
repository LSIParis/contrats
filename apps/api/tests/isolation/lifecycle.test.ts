import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { LifecycleService } from '../../src/jobs/lifecycle.service.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';

let app: INestApplication;
let fx: TwoCustomerFixture;
let lifecycle: LifecycleService;

const DAY = 86_400_000;

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
  lifecycle = mod.get(LifecycleService);
  fx = await seedTwoCustomers();
});

/** Crée un contrat minimal dans le client A. */
async function makeContract(over: {
  status: string;
  startDate?: Date | null;
  endDate?: Date | null;
  noticePeriodDays?: number | null;
  signedAt?: Date | null;
  successorContractId?: string | null;
  reminderCycle?: number;
  type?: string;
  parentContractId?: string | null;
}): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.create({
      data: {
        id,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        reference: `LSI-2026-${id.slice(-12)}`,
        title: 'Contrat cycle de vie',
        type: (over.type as any) ?? 'MAIN',
        status: over.status as any,
        category: 'MAINTENANCE',
        currency: 'EUR',
        billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId,
        startDate: over.startDate ?? null,
        endDate: over.endDate ?? null,
        noticePeriodDays: over.noticePeriodDays ?? null,
        signedAt: over.signedAt ?? null,
        successorContractId: over.successorContractId ?? null,
        reminderCycle: over.reminderCycle ?? 0,
        parentContractId: over.parentContractId ?? null,
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
        updatedByUserId: fx.amUserId,
      },
    }),
  );
  return id;
}

async function getContract(id: string) {
  return withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.findUnique({ where: { id } }),
  );
}
async function reminders(contractId: string) {
  return withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.reminder.findMany({ where: { contractId }, orderBy: { offsetDays: 'desc' } }),
  );
}

// ===========================================================================
// RM-06 / RM-23 — activation + matérialisation des rappels
// ===========================================================================

describe('RM-06 / RM-23 — activation automatique', () => {
  test('un contrat signé dont la date de début est atteinte devient ACTIVE et matérialise 3 rappels', async () => {
    const id = await makeContract({
      status: 'SIGNED',
      startDate: new Date(Date.now() - 2 * DAY),
      endDate: new Date(Date.now() + 120 * DAY), // J-90/60/30 tous dans le futur
    });

    await lifecycle.run(new Date());

    const c = await getContract(id);
    expect(c!.status).toBe('ACTIVE');
    expect(c!.activatedAt).toBeTruthy();

    const rs = await reminders(id);
    expect(rs.map((r) => r.offsetDays)).toEqual([90, 60, 30]);
    expect(rs.every((r) => r.kind === 'EXPIRY')).toBe(true);
    expect(rs.every((r) => r.status === 'PENDING')).toBe(true);
  });

  test('RM-25 / EC-02 : les offsets déjà passés naissent SKIPPED_OBSOLETE', async () => {
    // Terme dans 45 j : J-90 et J-60 sont déjà passés, seul J-30 est futur.
    const id = await makeContract({
      status: 'SIGNED',
      startDate: new Date(Date.now() - 1 * DAY),
      endDate: new Date(Date.now() + 45 * DAY),
    });

    await lifecycle.run(new Date());

    const rs = await reminders(id);
    const byOffset = Object.fromEntries(rs.map((r) => [r.offsetDays, r.status]));
    expect(byOffset[90]).toBe('SKIPPED_OBSOLETE');
    expect(byOffset[60]).toBe('SKIPPED_OBSOLETE');
    expect(byOffset[30]).toBe('PENDING');
  });

  test('idempotent : un second balayage ne recrée pas de rappels ni n’échoue', async () => {
    const id = await makeContract({
      status: 'SIGNED',
      startDate: new Date(Date.now() - 2 * DAY),
      endDate: new Date(Date.now() + 120 * DAY),
    });

    await lifecycle.run(new Date());
    await lifecycle.run(new Date()); // le contrat est déjà ACTIVE : non redécouvert

    const rs = await reminders(id);
    expect(rs).toHaveLength(3);
  });

  test('un contrat dont la date de début est FUTURE reste SIGNED, sans rappel', async () => {
    const id = await makeContract({
      status: 'SIGNED',
      startDate: new Date(Date.now() + 10 * DAY),
      endDate: new Date(Date.now() + 200 * DAY),
    });

    await lifecycle.run(new Date());

    expect((await getContract(id))!.status).toBe('SIGNED');
    expect(await reminders(id)).toHaveLength(0);
  });
});

// ===========================================================================
// Revue finale phase-e-avenants — un avenant ne s'active jamais seul
// ===========================================================================

describe("avenant — ne s'active jamais de façon autonome (rappels en double)", () => {
  test("un AVENANT signé dont la date de début est atteinte RESTE SIGNED et ne matérialise aucun rappel", async () => {
    // startDate = celle du parent, donc souvent PASSÉE ; type filtré nulle
    // part côté SQL (app_find_contracts_to_activate ne connaît que
    // status+start_date) — c'est ICI, dans le job, que le type doit
    // court-circuiter l'activation. Sans la garde, l'avenant serait ACTIVÉ
    // et poserait SES PROPRES rappels J-90/60/30 → doublon avec ceux du
    // parent (RM-18 les reporte déjà sur le parent à la signature).
    const parentId = await makeContract({
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 400 * DAY),
      endDate: new Date(Date.now() + 200 * DAY),
    });
    const amendmentId = await makeContract({
      type: 'AMENDMENT',
      parentContractId: parentId,
      status: 'SIGNED',
      startDate: new Date(Date.now() - 2 * DAY), // dans le passé, comme le parent
      endDate: new Date(Date.now() + 120 * DAY),
    });

    await lifecycle.run(new Date());

    const av = await getContract(amendmentId);
    expect(av!.status).toBe('SIGNED');
    expect(av!.activatedAt).toBeNull();
    expect(await reminders(amendmentId)).toHaveLength(0);
  });

  test('preuve que la garde est spécifique au type : un contrat MAIN SIGNED dans le même run continue de s’activer et de recevoir ses rappels', async () => {
    const parentId = await makeContract({
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 400 * DAY),
      endDate: new Date(Date.now() + 200 * DAY),
    });
    const amendmentId = await makeContract({
      type: 'AMENDMENT',
      parentContractId: parentId,
      status: 'SIGNED',
      startDate: new Date(Date.now() - 2 * DAY),
      endDate: new Date(Date.now() + 120 * DAY),
    });
    const mainId = await makeContract({
      status: 'SIGNED',
      startDate: new Date(Date.now() - 2 * DAY),
      endDate: new Date(Date.now() + 120 * DAY),
    });

    await lifecycle.run(new Date());

    expect((await getContract(amendmentId))!.status).toBe('SIGNED');
    expect(await reminders(amendmentId)).toHaveLength(0);

    const main = await getContract(mainId);
    expect(main!.status).toBe('ACTIVE');
    expect(main!.activatedAt).toBeTruthy();
    const mainReminders = await reminders(mainId);
    expect(mainReminders.map((r) => r.offsetDays)).toEqual([90, 60, 30]);
  });
});

// ===========================================================================
// RM-07 — expiration + annulation des rappels
// ===========================================================================

describe('RM-07 — expiration automatique', () => {
  test('un contrat actif dont le terme est dépassé, sans successeur, devient EXPIRED et ses rappels PENDING sont annulés', async () => {
    const id = await makeContract({
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 400 * DAY),
      endDate: new Date(Date.now() - 1 * DAY),
    });
    // Un rappel PENDING résiduel (échéance déjà obsolète) à annuler.
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.reminder.create({
        data: {
          id: uuidv7(),
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId: id,
          kind: 'EXPIRY',
          offsetDays: 30,
          cycle: 0,
          dueAt: new Date(Date.now() - 5 * DAY),
          status: 'PENDING',
          createdAt: new Date(),
        },
      }),
    );

    await lifecycle.run(new Date());

    expect((await getContract(id))!.status).toBe('EXPIRED');
    const rs = await reminders(id);
    expect(rs.every((r) => r.status === 'CANCELLED')).toBe(true);
  });

  test('RM-07 : un successeur signé transforme l’expiration en RENEWED', async () => {
    const successorId = await makeContract({
      status: 'SIGNED',
      startDate: new Date(Date.now() + 1 * DAY),
      endDate: new Date(Date.now() + 365 * DAY),
      signedAt: new Date(Date.now() - 2 * DAY),
    });
    const id = await makeContract({
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 400 * DAY),
      endDate: new Date(Date.now() - 1 * DAY),
      successorContractId: successorId,
    });

    await lifecycle.run(new Date());

    expect((await getContract(id))!.status).toBe('RENEWED');
  });

  test('un contrat actif encore dans son terme n’est pas expiré', async () => {
    const id = await makeContract({
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 30 * DAY),
      endDate: new Date(Date.now() + 30 * DAY),
    });

    await lifecycle.run(new Date());

    expect((await getContract(id))!.status).toBe('ACTIVE');
  });
});
