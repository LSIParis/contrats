import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import {
  JOB_QUEUE,
  type CaptureProofJob,
  type JobQueue,
  type SendReminderJob,
} from '../../src/jobs/job-queue.port.js';
import { ReminderDispatchService } from '../../src/jobs/reminder-dispatch.service.js';
import { ReminderSendService } from '../../src/jobs/reminder-send.service.js';
import { EMAIL_SENDER } from '../../src/notifications/email.token.js';
import { seedTwoCustomers, assignAdminRole, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { adminScope, systemScope, withScope, uuidv7 } from '@lsi/persistence';
import type { EmailMessage, EmailSender } from '@lsi/domain';

const DAY = 86_400_000;

class FakeEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
}
class RecordingQueue implements JobQueue {
  readonly reminderJobs: SendReminderJob[] = [];
  async enqueueCaptureProof(_d: CaptureProofJob): Promise<void> {}
  async enqueueSendReminder(d: SendReminderJob): Promise<void> {
    this.reminderJobs.push(d);
  }
}

let app: INestApplication;
let fx: TwoCustomerFixture;
let dispatch: ReminderDispatchService;
let sender: ReminderSendService;
const email = new FakeEmail();
const queue = new RecordingQueue();

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER)
    .useValue(email)
    .overrideProvider(JOB_QUEUE)
    .useValue(queue)
    .compile();
  app = mod.createNestApplication();
  await app.init();
  dispatch = mod.get(ReminderDispatchService);
  sender = mod.get(ReminderSendService);

  fx = await seedTwoCustomers();
  await assignAdminRole(fx.tenantId, fx.adminUserId);
});

beforeEach(() => {
  email.sent.length = 0;
  queue.reminderJobs.length = 0;
});

/** Contrat ACTIVE du client A, propriétaire = amUserId. */
async function makeActiveContract(endInDays = 60): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.contract.create({
      data: {
        id,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        reference: `LSI-2026-${id.slice(-12)}`,
        title: 'Maintenance parc',
        type: 'MAIN',
        status: 'ACTIVE',
        category: 'MAINTENANCE',
        currency: 'EUR',
        billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId,
        startDate: new Date(now.getTime() - 300 * DAY),
        endDate: new Date(now.getTime() + endInDays * DAY),
        activatedAt: new Date(now.getTime() - 300 * DAY),
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
        updatedByUserId: fx.amUserId,
      },
    }),
  );
  return id;
}

async function makeReminder(contractId: string, offset: number, dueAt: Date): Promise<string> {
  const id = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.reminder.create({
      data: {
        id,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId,
        kind: 'EXPIRY',
        offsetDays: offset,
        cycle: 0,
        dueAt,
        status: 'PENDING',
        createdAt: new Date(),
      },
    }),
  );
  return id;
}

async function makePrimaryContact(): Promise<string> {
  const em = `contact-${uuidv7().slice(-12)}@dupont.fr`;
  // Un seul contact primaire par client : sinon le service prend le premier
  // (celui d'un test précédent) et l'assertion porte sur le mauvais email.
  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.customerContact.deleteMany({ where: { customerId: fx.customerA.id } });
    await tx.customerContact.create({
      data: {
        id: uuidv7(),
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        firstName: 'Jean',
        lastName: 'Dupont',
        email: em,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  });
  return em;
}

async function getReminder(id: string) {
  return withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.reminder.findUnique({ where: { id } }),
  );
}
async function notifCount(reminderId: string) {
  // Sous la MÊME portée que l'écriture (systemScope du client A) : la notif
  // interne porte customerId = customerA.
  return withScope(systemScope(fx.tenantId, fx.customerA.id), (tx) =>
    tx.notification.count({ where: { relatedReminderId: reminderId } }),
  );
}

const scope = () => systemScope(fx.tenantId, fx.customerA.id);

// ===========================================================================
// §12.3 — découverte / dispatch
// ===========================================================================

describe('§12.3 — dispatch des rappels dus', () => {
  test('un rappel PENDING échu est enfilé ; un rappel futur ne l’est pas', async () => {
    const c = await makeActiveContract();
    const due = await makeReminder(c, 90, new Date(Date.now() - 1 * DAY));
    const future = await makeReminder(c, 60, new Date(Date.now() + 10 * DAY));

    await dispatch.run();

    const ids = queue.reminderJobs.map((j) => j.reminderId);
    expect(ids).toContain(due);
    expect(ids).not.toContain(future);
  });

  test('un rappel déjà envoyé n’est pas réenfilé', async () => {
    const c = await makeActiveContract();
    const sent = await makeReminder(c, 30, new Date(Date.now() - 2 * DAY));
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.reminder.update({ where: { id: sent }, data: { status: 'SENT', sentAt: new Date() } }),
    );

    await dispatch.run();

    expect(queue.reminderJobs.map((j) => j.reminderId)).not.toContain(sent);
  });
});

// ===========================================================================
// RM-27 — qui reçoit quoi
// ===========================================================================

describe('RM-27 — J-90 interne seul', () => {
  test('seul l’account manager est notifié ; aucun email client', async () => {
    const c = await makeActiveContract(90);
    await makePrimaryContact();
    const r = await makeReminder(c, 90, new Date(Date.now() - 1 * DAY));

    const ok = await sender.send(scope(), r, new Date());

    expect(ok).toBe(true);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(fx.amEmail);
    expect((await getReminder(r))!.status).toBe('SENT');
    expect(await notifCount(r)).toBe(1);
  });
});

describe('RM-27 — J-60 + client', () => {
  test('ACTIVE sans renouvellement : email interne + email client', async () => {
    const c = await makeActiveContract(60);
    const clientEmail = await makePrimaryContact();
    const r = await makeReminder(c, 60, new Date(Date.now() - 1 * DAY));

    await sender.send(scope(), r, new Date());

    const to = email.sent.map((m) => m.to);
    expect(to).toContain(fx.amEmail);
    expect(to).toContain(clientEmail);
    expect(email.sent).toHaveLength(2);
  });

  test('renouvellement EN COURS : pas d’email client', async () => {
    const c = await makeActiveContract(60);
    await makePrimaryContact();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.renewalRequest.create({
        data: {
          id: uuidv7(),
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId: c,
          status: 'PENDING',
          initiatedByUserId: fx.amUserId,
          initiatedAt: new Date(),
        },
      }),
    );
    const r = await makeReminder(c, 60, new Date(Date.now() - 1 * DAY));

    await sender.send(scope(), r, new Date());

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(fx.amEmail);
  });
});

describe('RM-27 — J-30 escalade', () => {
  test('aucune demande de renouvellement : interne + client + MSP_ADMIN', async () => {
    const c = await makeActiveContract(30);
    const clientEmail = await makePrimaryContact();
    const r = await makeReminder(c, 30, new Date(Date.now() - 1 * DAY));

    await sender.send(scope(), r, new Date());

    const to = email.sent.map((m) => m.to);
    expect(to).toContain(fx.amEmail); // interne
    expect(to).toContain(clientEmail); // client
    expect(to.some((e) => e.startsWith('adm-'))).toBe(true); // escalade MSP_ADMIN
  });
});

// ===========================================================================
// RM-26 — retard / idempotence
// ===========================================================================

describe('RM-26 — retard et idempotence', () => {
  test('un rappel envoyé bien après son échéance est marqué late', async () => {
    const c = await makeActiveContract(90);
    const r = await makeReminder(c, 90, new Date(Date.now() - 3 * DAY));

    await sender.send(scope(), r, new Date());

    expect((await getReminder(r))!.late).toBe(true);
  });

  test('un rappel à l’heure n’est pas marqué late', async () => {
    const c = await makeActiveContract(90);
    const r = await makeReminder(c, 90, new Date(Date.now() - 1 * 3_600_000)); // il y a 1 h

    await sender.send(scope(), r, new Date());

    expect((await getReminder(r))!.late).toBe(false);
  });

  test('rejouer l’envoi ne double pas la notification et laisse le rappel SENT', async () => {
    const c = await makeActiveContract(90);
    const r = await makeReminder(c, 90, new Date(Date.now() - 1 * DAY));

    expect(await sender.send(scope(), r, new Date())).toBe(true);
    expect(await sender.send(scope(), r, new Date())).toBe(false); // plus PENDING

    expect((await getReminder(r))!.status).toBe('SENT');
    expect(await notifCount(r)).toBe(1);
  });
});
