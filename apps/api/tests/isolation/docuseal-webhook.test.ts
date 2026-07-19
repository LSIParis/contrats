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
