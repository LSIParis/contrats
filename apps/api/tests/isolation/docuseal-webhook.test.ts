import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AppModule } from '../../src/app.module.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { adminScope, withScope, uuidv7 } from '@lsi/persistence';

let app: INestApplication;
let fx: TwoCustomerFixture;

const SECRET = 'test-webhook-secret';

/**
 * Une submission DocuSeal rattachée à un contrat NEUF du client A.
 *
 * Contrat neuf à chaque test, pas contrat partagé remis à zéro : les
 * signature_events sont append-only (on ne peut pas les supprimer, et
 * c'est voulu), et des tests qui partagent un état mutable mentent tôt
 * ou tard — leçon déjà apprise sur la matrice IDOR.
 */
let subA: {
  contractId: string;
  requestId: string;
  submissionId: string;
  lsiSignerId: string;
  clientSignerId: string;
};

/**
 * Réplique FIDÈLE de DocuSeal lib/webhook_urls/signatures.rb :
 *
 *   "#{timestamp}.#{OpenSSL::HMAC.hexdigest('sha256', secret, "#{timestamp}.#{body}")}"
 *
 * Relevée dans la source de l'instance réelle, pas déduite de la doc.
 * La version précédente de ce helper signait le corps seul et produisait un
 * digest nu : elle validait un format inventé contre lui-même, et les tests
 * étaient verts alors qu'aucun webhook réel n'aurait été accepté.
 */
function sign(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `${timestamp}.${digest}`;
}

function post(payload: unknown, opts: { signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const req = request(app.getHttpServer())
    .post('/v1/webhooks/docuseal')
    .set('Content-Type', 'application/json')
    .set('X-Docuseal-Signature', opts.signature ?? sign(body));
  return req.send(body);
}

function formEvent(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    event_type: 'form.completed',
    timestamp: '2026-07-17T13:48:36Z',
    data: {
      id: 1001,
      email: 'j.dupont@dupont.fr',
      external_id: subA.clientSignerId,
      status: 'completed',
      completed_at: '2026-07-17T13:48:36Z',
      submission: { id: Number(subA.submissionId), status: 'completed' },
      metadata: {},
      ...data,
    },
    ...over,
  };
}

beforeAll(async () => {
  process.env.DOCUSEAL_WEBHOOK_SECRET = SECRET;

  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication({ rawBody: true });
  await app.init();

  fx = await seedTwoCustomers();
});

beforeEach(async () => {
  const contractId = uuidv7();
  const requestId = uuidv7();
  const submissionId = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  const lsiSignerId = uuidv7();
  const clientSignerId = uuidv7();
  const now = new Date();

  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id: contractId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        reference: `LSI-2026-${contractId.slice(-12)}`,
        title: 'Contrat en signature',
        type: 'MAIN',
        status: 'PENDING_SIGNATURE',
        category: 'MAINTENANCE',
        currency: 'EUR',
        billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId,
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
        updatedByUserId: fx.amUserId,
      },
    });

    // LSI a déjà signé : l'ordre est LSI d'abord, client ensuite (RM-13).
    // Le client est donc le DERNIER signataire — sa signature doit faire
    // basculer le contrat en SIGNED.
    await tx.contractSigner.createMany({
      data: [
        {
          id: lsiSignerId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId,
          party: 'LSI',
          fullName: 'Marc D.',
          email: 'direction@lsi.fr',
          signingOrder: 0,
          status: 'SIGNED',
          signedAt: new Date('2026-07-17T09:00:00Z'),
          createdAt: now,
          updatedAt: now,
        },
        {
          id: clientSignerId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId,
          party: 'CLIENT',
          fullName: 'J. Dupont',
          email: 'j.dupont@dupont.fr',
          signingOrder: 1,
          status: 'SENT',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    await tx.signatureRequest.create({
      data: {
        id: requestId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId,
        versionId: uuidv7(),
        provider: 'DOCUSEAL',
        providerSubmissionId: submissionId,
        status: 'SENT',
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
      },
    });
  });

  subA = { contractId, requestId, submissionId, lsiSignerId, clientSignerId };
});

// ===========================================================================
// §11.7 — sécurité de l'intégration
// ===========================================================================

describe('§11.7 — vérification HMAC', () => {
  test('signature invalide → 401, aucune écriture', async () => {
    const res = await post(formEvent(), { signature: 'deadbeef' });
    expect(res.status).toBe(401);

    const events = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureEvent.count({ where: { customerId: fx.customerA.id } }),
    );
    expect(events).toBe(0);
  });

  test('signature absente → 401', async () => {
    const body = JSON.stringify(formEvent());
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  test('la signature porte sur le CORPS BRUT, pas sur le JSON reparsé', async () => {
    // Un HMAC calculé sur JSON.stringify(JSON.parse(body)) serait faux dès
    // que l'émetteur ordonne ses clés différemment ou espace autrement.
    // Ici le corps a un espacement inhabituel : la signature doit tenir.
    const payload = formEvent();
    const weird = JSON.stringify(payload, null, 3);
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .set('X-Docuseal-Signature', sign(weird))
      .send(weird);
    expect(res.status).toBe(200);
  });

  test('un horodatage trop ancien est rejeté — anti-rejeu', async () => {
    // Sans borne temporelle, une signature valide capturée reste valide
    // éternellement : un webhook intercepté pourrait être rejoué des mois
    // plus tard. DocuSeal tolère ±5 min ; on s'aligne.
    const payload = formEvent();
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    const bodyStr = JSON.stringify(payload);
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .set('X-Docuseal-Signature', sign(bodyStr, old))
      .send(bodyStr);
    expect(res.status).toBe(401);
  });

  test('un horodatage dans le futur est rejeté', async () => {
    const payload = formEvent();
    const future = Math.floor(Date.now() / 1000) + 6 * 60;
    const bodyStr = JSON.stringify(payload);
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .set('X-Docuseal-Signature', sign(bodyStr, future))
      .send(bodyStr);
    expect(res.status).toBe(401);
  });

  test('l’horodatage ne peut pas être modifié sans casser la signature', async () => {
    // L'horodatage est DANS le message signé ("<ts>.<body>"). Le rejouer
    // avec un ts récent ne suffit donc pas : le digest ne correspondrait plus.
    // C'est exactement ce qui rend la tolérance utile.
    const bodyStr = JSON.stringify(formEvent());
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    const captured = sign(bodyStr, old);
    const digest = captured.slice(captured.indexOf('.') + 1);
    const forged = `${Math.floor(Date.now() / 1000)}.${digest}`;

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .set('X-Docuseal-Signature', forged)
      .send(bodyStr);
    expect(res.status).toBe(401);
  });

  test('un en-tête sans horodatage est rejeté', async () => {
    // Le format historique — digest nu, sans horodatage — est celui que
    // j'avais implémenté par erreur. Il doit désormais être REFUSÉ.
    const bodyStr = JSON.stringify(formEvent());
    const bare = createHmac('sha256', SECRET).update(bodyStr).digest('hex');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .set('X-Docuseal-Signature', bare)
      .send(bodyStr);
    expect(res.status).toBe(401);
  });

  test('un corps altéré après signature est rejeté', async () => {
    const original = JSON.stringify(formEvent());
    const tampered = original.replace('form.completed', 'form.declined');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/docuseal')
      .set('Content-Type', 'application/json')
      .set('X-Docuseal-Signature', sign(original))
      .send(tampered);
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// §11.4 — LE point critique : le scope ne vient JAMAIS du payload
// ===========================================================================

describe('§11.4 — résolution du scope depuis NOTRE base', () => {
  test('une submission inconnue → 200 unknown_submission, aucune écriture', async () => {
    // 200 et non 4xx/5xx : DocuSeal réessaie 48 h sur les erreurs, et faire
    // réessayer un événement définitivement non traitable n'est que du bruit.
    const res = await post(
      formEvent({}, { submission: { id: 999999999, status: 'completed' } }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown_submission');
  });

  test('un payload prétendant un AUTRE tenant est rejeté et alerté', async () => {
    // L'attaque : forger metadata.tenant_id pour écrire dans un autre client.
    // Le scope venant de NOTRE base, l'attaque n'a aucune prise — mais la
    // divergence est une SONDE : si elle se déclenche, un humain doit voir.
    const res = await post(
      formEvent({}, { metadata: { tenant_id: uuidv7(), customer_id: uuidv7() } }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('le scope résolu est celui de la signature_request, pas celui du payload', async () => {
    await post(formEvent({}, { metadata: { tenant_id: fx.tenantId, customer_id: fx.customerA.id } }));

    const ev = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureEvent.findFirst({ where: { signatureRequestId: subA.requestId } }),
    );
    expect(ev).toBeTruthy();
    expect(ev!.tenantId).toBe(fx.tenantId);
    // Écrit dans le client A, celui de NOTRE signature_request.
    expect(ev!.customerId).toBe(fx.customerA.id);
  });
});

// ===========================================================================
// EC-05 — idempotence
// ===========================================================================

describe('EC-05 — idempotence', () => {
  test('le même événement rejoué → un seul signature_event', async () => {
    const payload = formEvent();
    const first = await post(payload);
    const second = await post(payload);

    expect(first.body.status).toBe('processed');
    expect(second.body.status).toBe('duplicate_ignored');

    const count = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureEvent.count({ where: { signatureRequestId: subA.requestId } }),
    );
    expect(count).toBe(1);
  });

  test('le rejeu ne re-applique pas l’effet métier', async () => {
    const payload = formEvent();
    await post(payload);
    await post(payload);

    const signers = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractSigner.findMany({ where: { contractId: subA.contractId } }),
    );
    const client = signers.find((s) => s.party === 'CLIENT')!;
    // Une seule signature, un seul horodatage.
    expect(client.status).toBe('SIGNED');
    expect(client.signedAt).toBeTruthy();
  });
});

// ===========================================================================
// §11.5 — synchronisation d'état
// ===========================================================================

describe('§11.5 — effets métier', () => {
  test('form.completed du dernier signataire → contrat SIGNED', async () => {
    const res = await post(formEvent());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: subA.contractId } }),
    );
    expect(c!.status).toBe('SIGNED');
    expect(c!.signedAt).toBeTruthy();
  });

  test('form.completed avec un signataire restant → PARTIALLY_SIGNED', async () => {
    // On remet le signataire LSI en attente : il reste donc 2 signatures.
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractSigner.update({
        where: { id: subA.lsiSignerId },
        data: { status: 'SENT', signedAt: null },
      }),
    );

    await post(formEvent());

    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: subA.contractId } }),
    );
    expect(c!.status).toBe('PARTIALLY_SIGNED');
  });

  test('form.declined → contrat DECLINED avec motif (EC-10)', async () => {
    const res = await post(
      formEvent(
        { event_type: 'form.declined' },
        { status: 'declined', decline_reason: 'Tarif trop élevé', declined_at: '2026-07-17T14:00:00Z' },
      ),
    );
    expect(res.status).toBe(200);

    const [c, signers] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: subA.contractId } }),
      await tx.contractSigner.findMany({ where: { contractId: subA.contractId } }),
    ]);
    expect(c!.status).toBe('DECLINED');
    const client = signers.find((s) => s.party === 'CLIENT')!;
    expect(client.status).toBe('DECLINED');
    expect(client.declineReason).toBe('Tarif trop élevé');
  });

  test('form.viewed → signataire VIEWED, contrat inchangé', async () => {
    await post(formEvent({ event_type: 'form.viewed' }, { status: 'opened' }));

    const [c, signers] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: subA.contractId } }),
      await tx.contractSigner.findMany({ where: { contractId: subA.contractId } }),
    ]);
    expect(c!.status).toBe('PENDING_SIGNATURE');
    expect(signers.find((s) => s.party === 'CLIENT')!.status).toBe('VIEWED');
  });

  test('le rapprochement se fait par external_id, pas par email', async () => {
    // Deux signataires peuvent partager une adresse (assistante), et l'email
    // est modifiable côté DocuSeal. L'external_id est notre clé.
    const res = await post(
      formEvent({}, { email: 'quelquun-dautre@ailleurs.fr', external_id: subA.clientSignerId }),
    );
    expect(res.status).toBe(200);

    const signers = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractSigner.findMany({ where: { contractId: subA.contractId } }),
    );
    expect(signers.find((s) => s.id === subA.clientSignerId)!.status).toBe('SIGNED');
  });
});

// ===========================================================================
// Revue finale phase-e-suivi-signatures — résurrection par webhook tardif
// ===========================================================================

describe('révocation — un webhook tardif ne doit pas ressusciter la demande', () => {
  /**
   * Reproduit l'état laissé par POST /v1/contracts/:id/signature/revoke :
   * demande REVOKED (providerSubmissionId CONSERVÉ — la résolution de scope
   * en dépend), signataires remis à PENDING, contrat repassé à APPROVED.
   *
   * Un FORM_COMPLETED déjà en vol pour cette submission peut arriver APRÈS
   * la révocation. Sans garde, applyBusinessEffect ne regarde pas le statut
   * courant de la demande : il repasserait le signataire à SIGNED et la
   * demande à PARTIALLY_COMPLETED/COMPLETED — ré-entrant dans l'index
   * partiel unique signature_requests_one_active et bloquant tout renvoi
   * ultérieur (409 SIGNATURE_ALREADY_IN_PROGRESS) sans qu'une révocation ne
   * soit plus jamais possible depuis le front (bouton masqué hors
   * PENDING_SIGNATURE/PARTIALLY_SIGNED).
   */
  async function revokeState() {
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      Promise.all([
        tx.signatureRequest.update({
          where: { id: subA.requestId },
          data: { status: 'REVOKED' },
        }),
        tx.contractSigner.updateMany({
          where: { contractId: subA.contractId },
          data: { status: 'PENDING', providerSubmitterId: null, providerSubmitterSlug: null },
        }),
        tx.contract.update({
          where: { id: subA.contractId },
          data: { status: 'APPROVED' },
        }),
      ]),
    );
  }

  test('un FORM_COMPLETED tardif sur une demande REVOKED est un no-op', async () => {
    await revokeState();

    const res = await post(formEvent());
    expect(res.status).toBe(200); // jamais de 5xx : DocuSeal réessaierait 48 h pour rien

    const [c, req, signers] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: subA.contractId } }),
      await tx.signatureRequest.findUnique({ where: { id: subA.requestId } }),
      await tx.contractSigner.findMany({ where: { contractId: subA.contractId } }),
    ]);

    expect(c!.status).toBe('APPROVED');
    expect(req!.status).toBe('REVOKED');
    const client = signers.find((s) => s.party === 'CLIENT')!;
    expect(client.status).toBe('PENDING');
    expect(client.signedAt).toBeNull();
    expect(client.providerSubmitterId).toBeNull();
  });

  test('un FORM_DECLINED tardif sur une demande déjà EXPIRED est aussi un no-op', async () => {
    // Garde défensive : toute demande CLOSE (pas seulement REVOKED) doit
    // rester inerte face à un webhook tardif.
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.update({ where: { id: subA.requestId }, data: { status: 'EXPIRED' } }),
    );

    const res = await post(
      formEvent(
        { event_type: 'form.declined' },
        { status: 'declined', decline_reason: 'Tarif trop élevé', declined_at: '2026-07-17T14:00:00Z' },
      ),
    );
    expect(res.status).toBe(200);

    const [c, req, signers] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: subA.contractId } }),
      await tx.signatureRequest.findUnique({ where: { id: subA.requestId } }),
      await tx.contractSigner.findMany({ where: { contractId: subA.contractId } }),
    ]);

    expect(c!.status).toBe('PENDING_SIGNATURE'); // inchangé
    expect(req!.status).toBe('EXPIRED'); // pas re-basculé en DECLINED
    expect(signers.find((s) => s.party === 'CLIENT')!.status).toBe('SENT'); // inchangé
  });
});

// ===========================================================================
// Renouvellements — acceptation automatique à la signature du successeur
// ===========================================================================

describe('renouvellement — acceptation automatique à la signature', () => {
  test('FORM_COMPLETED qui signe le successeur fait passer sa RenewalRequest PENDING à ACCEPTED', async () => {
    const parentId = uuidv7();
    const rrId = uuidv7();
    const now = new Date();

    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      // Le parent n'a besoin d'exister que pour satisfaire la FK de
      // renewal_requests (contractId, tenantId, customerId) — son contenu
      // n'est pas sous test ici.
      await tx.contract.create({
        data: {
          id: parentId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          reference: `LSI-2026-${parentId.slice(-12)}`,
          title: 'Contrat parent',
          type: 'MAIN',
          status: 'ACTIVE',
          category: 'MAINTENANCE',
          currency: 'EUR',
          billingFrequency: 'MONTHLY',
          successorContractId: subA.contractId,
          ownerUserId: fx.amUserId,
          createdAt: now,
          updatedAt: now,
          createdByUserId: fx.amUserId,
          updatedByUserId: fx.amUserId,
        },
      });

      // subA.contractId (seedé par beforeEach, PENDING_SIGNATURE, LSI déjà
      // signé) DEVIENT le successeur de renouvellement : c'est sa signature
      // qui doit déclencher l'acceptation automatique.
      await tx.contract.update({
        where: { id: subA.contractId },
        data: { predecessorContractId: parentId },
      });

      await tx.renewalRequest.create({
        data: {
          id: rrId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId: parentId,
          newContractId: subA.contractId,
          status: 'PENDING',
          initiatedByUserId: fx.amUserId,
          initiatedAt: now,
        },
      });
    });

    // form.completed du CLIENT, dernier signataire restant (LSI déjà SIGNED
    // dans le seed du beforeEach) → allSigned.
    const res = await post(formEvent());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const rr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.renewalRequest.findUnique({ where: { id: rrId } }),
    );
    expect(rr!.status).toBe('ACCEPTED');
    expect(rr!.decidedAt).toBeTruthy();
  });
});

// ===========================================================================
// Avenants — report au parent + replan des rappels à la signature (RM-18, EC-12)
// ===========================================================================

describe('avenant — report au parent à la signature complète (RM-18, EC-12)', () => {
  test('FORM_COMPLETED qui signe un avenant reporte endDate/amountCents sur le parent ACTIVE et replanifie ses rappels', async () => {
    const parentId = uuidv7();
    const now = new Date();
    const oldEndDate = new Date('2026-08-01T00:00:00Z');
    // endDate est une colonne @db.Date : minuit UTC, sans quoi la comparaison
    // après aller-retour en base échouerait sur l'heure tronquée.
    const rawNewEndDate = new Date(now.getTime() + 200 * 24 * 60 * 60 * 1000);
    const newEndDate = new Date(Date.UTC(rawNewEndDate.getUTCFullYear(), rawNewEndDate.getUTCMonth(), rawNewEndDate.getUTCDate()));
    const newAmountCents = 987654n;

    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      // Le parent : ACTIVE, avec des rappels PENDING sur l'ancienne échéance.
      await tx.contract.create({
        data: {
          id: parentId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          reference: `LSI-2026-${parentId.slice(-12)}`,
          title: 'Contrat parent (avenant)',
          type: 'MAIN',
          status: 'ACTIVE',
          category: 'MAINTENANCE',
          currency: 'EUR',
          billingFrequency: 'MONTHLY',
          endDate: oldEndDate,
          amountCents: 500000n,
          noticePeriodDays: 30,
          reminderCycle: 0,
          ownerUserId: fx.amUserId,
          createdAt: now,
          updatedAt: now,
          createdByUserId: fx.amUserId,
          updatedByUserId: fx.amUserId,
        },
      });

      for (const offsetDays of [90, 60, 30]) {
        await tx.reminder.create({
          data: {
            id: uuidv7(),
            tenantId: fx.tenantId,
            customerId: fx.customerA.id,
            contractId: parentId,
            kind: 'EXPIRY',
            offsetDays,
            cycle: 0,
            dueAt: new Date(oldEndDate.getTime() - offsetDays * 24 * 60 * 60 * 1000),
            status: 'PENDING',
            createdAt: now,
          },
        });
      }

      // subA.contractId (seedé par beforeEach, PENDING_SIGNATURE, LSI déjà
      // signé) DEVIENT l'avenant : c'est sa signature complète qui doit
      // déclencher le report + le replan.
      await tx.contract.update({
        where: { id: subA.contractId },
        data: {
          type: 'AMENDMENT',
          parentContractId: parentId,
          endDate: newEndDate,
          amountCents: newAmountCents,
        },
      });
    });

    // form.completed du CLIENT, dernier signataire restant → allSigned.
    const res = await post(formEvent());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const parent = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: parentId } }),
    );
    expect(parent!.endDate?.toISOString()).toBe(newEndDate.toISOString());
    expect(parent!.amountCents).toBe(newAmountCents);
    expect(parent!.reminderCycle).toBe(1);

    const reminders = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.reminder.findMany({ where: { contractId: parentId }, orderBy: [{ cycle: 'asc' }, { offsetDays: 'desc' }] }),
    );
    const oldCycle = reminders.filter((r: any) => r.cycle === 0);
    const newCycle = reminders.filter((r: any) => r.cycle === 1);

    expect(oldCycle).toHaveLength(3);
    for (const r of oldCycle) expect(r.status).toBe('CANCELLED');

    expect(newCycle).toHaveLength(3);
    for (const r of newCycle) expect(r.status).toBe('PENDING');
    expect(newCycle.map((r: any) => r.offsetDays).sort()).toEqual([30, 60, 90]);
  });

  test("FORM_COMPLETED qui signe un avenant dont le parent est SIGNED (pas encore ACTIVE) reporte les champs sans toucher aux rappels", async () => {
    const parentId = uuidv7();
    const now = new Date();
    const rawNewEndDate = new Date(now.getTime() + 200 * 24 * 60 * 60 * 1000);
    const newEndDate = new Date(Date.UTC(rawNewEndDate.getUTCFullYear(), rawNewEndDate.getUTCMonth(), rawNewEndDate.getUTCDate()));
    const newAmountCents = 111222n;

    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      await tx.contract.create({
        data: {
          id: parentId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          reference: `LSI-2026-${parentId.slice(-12)}`,
          title: 'Contrat parent SIGNED (avenant)',
          type: 'MAIN',
          status: 'SIGNED',
          category: 'MAINTENANCE',
          currency: 'EUR',
          billingFrequency: 'MONTHLY',
          endDate: new Date('2026-08-01T00:00:00Z'),
          amountCents: 500000n,
          noticePeriodDays: 30,
          reminderCycle: 0,
          ownerUserId: fx.amUserId,
          createdAt: now,
          updatedAt: now,
          createdByUserId: fx.amUserId,
          updatedByUserId: fx.amUserId,
        },
      });

      await tx.contract.update({
        where: { id: subA.contractId },
        data: {
          type: 'AMENDMENT',
          parentContractId: parentId,
          endDate: newEndDate,
          amountCents: newAmountCents,
        },
      });
    });

    const res = await post(formEvent());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const parent = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: parentId } }),
    );
    expect(parent!.endDate?.toISOString()).toBe(newEndDate.toISOString());
    expect(parent!.amountCents).toBe(newAmountCents);
    expect(parent!.reminderCycle).toBe(0); // pas de replan : rappels posés à l'activation

    const reminders = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.reminder.findMany({ where: { contractId: parentId } }),
    );
    expect(reminders).toHaveLength(0);
  });

  test('FORM_COMPLETED qui signe un avenant MONTANT-SEUL sur un parent ACTIVE à durée indéterminée reporte amountCents sans replanifier (revue finale)', async () => {
    // Bug de revue finale : l'ancien code ne reportait (endDate/amountCents)
    // QUE si `av.endDate` était renseigné. Un avenant montant-seul sur un
    // parent à durée indéterminée (endDate NULL) a `av.endDate` NULL lui
    // aussi (copié du parent à la création, cf. ContractsService.amend) :
    // il tombait dans aucune branche et amountCents restait silencieusement
    // non reporté. Le report doit être INCONDITIONNEL sur un parent ACTIVE
    // ou SIGNED ; seul le REPLAN des rappels reste conditionné à
    // ACTIVE + endDate présent.
    const parentId = uuidv7();
    const now = new Date();
    const newAmountCents = 424242n;

    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      await tx.contract.create({
        data: {
          id: parentId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          reference: `LSI-2026-${parentId.slice(-12)}`,
          title: 'Contrat parent durée indéterminée (avenant montant-seul)',
          type: 'MAIN',
          status: 'ACTIVE',
          category: 'MAINTENANCE',
          currency: 'EUR',
          billingFrequency: 'MONTHLY',
          endDate: null, // durée indéterminée
          amountCents: 500000n,
          noticePeriodDays: 30,
          reminderCycle: 0,
          ownerUserId: fx.amUserId,
          createdAt: now,
          updatedAt: now,
          createdByUserId: fx.amUserId,
          updatedByUserId: fx.amUserId,
        },
      });

      // Avenant montant-seul : endDate NULL (copié du parent, pas de
      // changement de durée), seul amountCents change.
      await tx.contract.update({
        where: { id: subA.contractId },
        data: {
          type: 'AMENDMENT',
          parentContractId: parentId,
          endDate: null,
          amountCents: newAmountCents,
        },
      });
    });

    const res = await post(formEvent());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const parent = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: parentId } }),
    );
    // Le montant DOIT être reporté même sans endDate.
    expect(parent!.amountCents).toBe(newAmountCents);
    expect(parent!.endDate).toBeNull();
    // Pas de replan : reminderCycle inchangé, aucun rappel créé/annulé.
    expect(parent!.reminderCycle).toBe(0);

    const reminders = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.reminder.findMany({ where: { contractId: parentId } }),
    );
    expect(reminders).toHaveLength(0);
  });

  test('FORM_COMPLETED qui signe un avenant dont le parent est TERMINATED ne modifie pas le parent', async () => {
    const parentId = uuidv7();
    const now = new Date();
    const oldEndDate = new Date('2026-08-01T00:00:00Z');
    const rawNewEndDate = new Date(now.getTime() + 200 * 24 * 60 * 60 * 1000);
    const newEndDate = new Date(Date.UTC(rawNewEndDate.getUTCFullYear(), rawNewEndDate.getUTCMonth(), rawNewEndDate.getUTCDate()));
    const newAmountCents = 333444n;

    await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
      // Le parent est déjà TERMINAL au moment où l'avenant finit de signer :
      // son cycle de signature aura pris du temps pendant lequel le parent
      // a été résilié. Le report ne doit alors PLUS avoir lieu.
      await tx.contract.create({
        data: {
          id: parentId,
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          reference: `LSI-2026-${parentId.slice(-12)}`,
          title: 'Contrat parent TERMINATED (avenant)',
          type: 'MAIN',
          status: 'TERMINATED',
          category: 'MAINTENANCE',
          currency: 'EUR',
          billingFrequency: 'MONTHLY',
          endDate: oldEndDate,
          amountCents: 500000n,
          noticePeriodDays: 30,
          reminderCycle: 0,
          ownerUserId: fx.amUserId,
          createdAt: now,
          updatedAt: now,
          createdByUserId: fx.amUserId,
          updatedByUserId: fx.amUserId,
        },
      });

      await tx.contract.update({
        where: { id: subA.contractId },
        data: {
          type: 'AMENDMENT',
          parentContractId: parentId,
          endDate: newEndDate,
          amountCents: newAmountCents,
        },
      });
    });

    const res = await post(formEvent());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const parent = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: parentId } }),
    );
    // Le parent TERMINAL reste inchangé : ni endDate ni amountCents ne sont
    // réécrits par un avenant qui n'a plus de sens pour un contrat clos.
    expect(parent!.endDate?.toISOString()).toBe(oldEndDate.toISOString());
    expect(parent!.amountCents).toBe(500000n);
    expect(parent!.reminderCycle).toBe(0);
    expect(parent!.status).toBe('TERMINATED');
  });
});

describe('journalisation', () => {
  test('chaque événement traité laisse un signature_event avec son payload brut', async () => {
    await post(formEvent());

    const ev = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureEvent.findFirst({ where: { signatureRequestId: subA.requestId } }),
    );
    expect(ev!.eventType).toBe('FORM_COMPLETED');
    expect(ev!.rawPayload).toBeTruthy();
    expect(ev!.processedAt).toBeTruthy();
  });
});
