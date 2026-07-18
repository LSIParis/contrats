import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { FakeProvider, FakeRenderer } from '../support/fakes.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { internalScope, adminScope, withScope, uuidv7 } from '@lsi/persistence';

let app: INestApplication;
let fx: TwoCustomerFixture;
let provider: FakeProvider;

const SESS_AM_A = 'sess-am-a';
let contractId: string;
let versionId: string;
let renderer: FakeRenderer;

beforeAll(async () => {
  provider = new FakeProvider();
  renderer = new FakeRenderer();

  const mod = await Test.createTestingModule({ imports: [AppModule] })
    // Le port est remplacé, pas le HTTP : on teste ICI la logique d'envoi
    // et les transitions. La conformité du payload DocuSeal est testée
    // séparément, dans le test de l'adaptateur.
    .overrideProvider(ESIGNATURE_PROVIDER)
    .useValue(provider)
    .overrideProvider(DOCUMENT_RENDERER)
    .useValue(renderer)
    .compile();

  app = mod.createNestApplication({ rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();

  fx = await seedTwoCustomers();

  await app.get(SessionService).put({
    sessionId: SESS_AM_A,
    userId: fx.amUserId,
    tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

/** Un contrat APPROVED, prêt à partir. Neuf à chaque test. */
async function seedApprovedContract(over: Record<string, unknown> = {}) {
  const id = uuidv7();
  const vId = uuidv7();
  const now = new Date();

  await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => {
    await tx.contract.create({
      data: {
        id,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        reference: `LSI-2026-${id.slice(-12)}`,
        title: 'Contrat de maintenance 2026',
        type: 'MAIN',
        status: 'APPROVED',
        category: 'MAINTENANCE',
        currentVersionId: vId,
        approvedVersionId: vId,
        startDate: new Date('2026-09-01'),
        endDate: new Date('2027-08-31'),
        amountCents: BigInt(1548000),
        currency: 'EUR',
        billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId,
        createdAt: now,
        updatedAt: now,
        createdByUserId: fx.amUserId,
        updatedByUserId: fx.amUserId,
        ...over,
      },
    });
    await tx.contractVersion.create({
      data: {
        id: vId,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId: id,
        versionNumber: 1,
        bodyHtml: '<h1>Contrat de maintenance</h1>',
        variables: {},
        createdAt: now,
        createdByUserId: fx.amUserId,
      },
    });
  });
  return { id, versionId: vId };
}

const body = () => ({
  signers: [
    { party: 'LSI', fullName: 'Marc D.', email: 'direction@lsi.fr', signingOrder: 0 },
    {
      party: 'CLIENT',
      fullName: 'J. Dupont',
      email: 'j.dupont@dupont.fr',
      signingOrder: 1,
      requireEmail2fa: true,
    },
  ],
});

function send(id: string, payload: unknown = body(), idem = uuidv7()) {
  return request(app.getHttpServer())
    .post(`/v1/contracts/${id}/send-for-signature`)
    .set('x-lsi-session', SESS_AM_A)
    .set('Idempotency-Key', idem)
    .send(payload as object);
}

beforeEach(async () => {
  provider.reset();
  const c = await seedApprovedContract();
  contractId = c.id;
  versionId = c.versionId;
});

// ===========================================================================
// RM-09 / RM-11 — gardes
// ===========================================================================

describe('RM-09 — pas de raccourci vers la signature', () => {
  test('envoyer un DRAFT → 409, aucun appel au provider', async () => {
    const c = await seedApprovedContract({ status: 'DRAFT', approvedVersionId: null });
    const res = await send(c.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTRACT_INVALID_TRANSITION');
    expect(provider.calls).toHaveLength(0);
  });

  test('envoyer un contrat IN_REVIEW → 409', async () => {
    const c = await seedApprovedContract({ status: 'IN_REVIEW', approvedVersionId: null });
    expect((await send(c.id)).status).toBe(409);
  });
});

describe('RM-11 — la validation porte sur une version', () => {
  test('envoyer après modification depuis la validation → 409', async () => {
    const c = await seedApprovedContract();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.update({ where: { id: c.id }, data: { currentVersionId: uuidv7() } }),
    );
    const res = await send(c.id);
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/revalidé/i);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('RM-12 — signataires obligatoires', () => {
  test('envoyer sans signataire client → 422', async () => {
    const res = await send(contractId, {
      signers: [{ party: 'LSI', fullName: 'Marc D.', email: 'direction@lsi.fr', signingOrder: 0 }],
    });
    expect(res.status).toBe(422);
    expect(provider.calls).toHaveLength(0);
  });

  test('envoyer sans signataire LSI → 422', async () => {
    const res = await send(contractId, {
      signers: [{ party: 'CLIENT', fullName: 'J. Dupont', email: 'j@d.fr', signingOrder: 0 }],
    });
    expect(res.status).toBe(422);
  });
});

// ===========================================================================
// EC-04 — jamais d'état fantôme
// ===========================================================================

describe('EC-04 — la transition n’est actée qu’APRÈS acquittement du provider', () => {
  test('succès → PENDING_SIGNATURE et signature_request SENT', async () => {
    const res = await send(contractId);
    expect(res.status).toBe(202); // 202 : la création chez le provider est asynchrone
    expect(res.body.status).toBe('SENT');

    const [c, sr] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: contractId } }),
      await tx.signatureRequest.findFirst({ where: { contractId } }),
    ]);
    expect(c!.status).toBe('PENDING_SIGNATURE');
    expect(sr!.status).toBe('SENT');
    expect(sr!.providerSubmissionId).toBeTruthy();
  });

  test('ÉCHEC du provider → le contrat RESTE APPROVED, aucun état fantôme', async () => {
    provider.failNext('DocuSeal indisponible');
    const res = await send(contractId);

    expect(res.status).toBe(502);
    expect(res.body.retryable).toBe(true);

    const [c, sr] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.contract.findUnique({ where: { id: contractId } }),
      await tx.signatureRequest.findFirst({ where: { contractId } }),
    ]);
    // Le contrat n'a PAS bougé : on ne prétend pas avoir envoyé.
    expect(c!.status).toBe('APPROVED');
    // Mais la tentative est tracée : un échec silencieux serait pire.
    expect(sr!.status).toBe('FAILED');
    expect(sr!.errorMessage).toMatch(/indisponible/i);
  });

  test('après un échec, un nouvel envoi reste possible', async () => {
    provider.failNext('panne passagère');
    await send(contractId);

    const res = await send(contractId);
    expect(res.status).toBe(202);

    const c = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contract.findUnique({ where: { id: contractId } }),
    );
    expect(c!.status).toBe('PENDING_SIGNATURE');
  });
});

// ===========================================================================
// §11.8 — idempotence
// ===========================================================================

describe('§11.8 — idempotence', () => {
  test('même Idempotency-Key rejouée → une seule submission, pas de double envoi', async () => {
    // Le cas réel : timeout réseau, le client réessaie. Sans idempotence,
    // le client reçoit DEUX invitations à signer le même contrat.
    const key = uuidv7();
    const first = await send(contractId, body(), key);
    const second = await send(contractId, body(), key);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.signatureRequestId).toBe(first.body.signatureRequestId);
    expect(provider.calls).toHaveLength(1);
  });

  test('Idempotency-Key absente → 400', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/contracts/${contractId}/send-for-signature`)
      .set('x-lsi-session', SESS_AM_A)
      .send(body());
    expect(res.status).toBe(400);
  });

  test('un second envoi concurrent est refusé tant qu’une demande est active', async () => {
    await send(contractId);
    const res = await send(contractId);
    // L'index partiel signature_requests_one_active (§8.5) l'interdit en base.
    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// §11.3 — ce qu'on envoie réellement au provider
// ===========================================================================

describe('§11.3 — contenu de la demande', () => {
  test('les signataires portent external_id = notre contract_signers.id', async () => {
    await send(contractId);
    const cmd = provider.calls[0]!;

    const signers = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractSigner.findMany({ where: { contractId } }),
    );
    // Le rapprochement des webhooks en dépend : jamais par email (§11.5).
    expect(cmd.submitters.map((s) => s.externalId).sort()).toEqual(signers.map((s) => s.id).sort());
  });

  test('l’ordre est préservé : LSI d’abord, client ensuite (RM-13)', async () => {
    await send(contractId);
    const cmd = provider.calls[0]!;
    expect(cmd.order).toBe('preserved');
    expect(cmd.submitters[0]!.party).toBe('LSI');
    expect(cmd.submitters[1]!.party).toBe('CLIENT');
  });

  test('chaque signataire porte le roleLabel de sa partie', async () => {
    // Le roleLabel doit être IDENTIQUE à la balise {{...;role=…}} du document,
    // sinon le signataire n'a aucun champ à signer (§11.3).
    await send(contractId);
    const cmd = provider.calls[0]!;
    const byParty = Object.fromEntries(cmd.submitters.map((s) => [s.party, s.roleLabel]));
    expect(byParty.LSI).toBe('LSI Maintenance');
    expect(byParty.CLIENT).toBe('Client');
  });

  test('le document envoyé contient une balise de signature par signataire', async () => {
    // Découvert contre l'EE réelle : sans balise dans le document, la
    // submission n'a rien à faire signer. Le send service annexe un bloc
    // de signature. Aucun champ pré-rempli (DocuSeal rejette les champs
    // inexistants — 422 « Unknown field »).
    await send(contractId);
    expect(renderer.lastHtml).toContain('{{Signature;role=LSI Maintenance;type=signature}}');
    expect(renderer.lastHtml).toContain('{{Signature;role=Client;type=signature}}');
    expect(provider.calls[0]!.submitters.every((s) => s.fields.length === 0)).toBe(true);
  });

  test('le 2FA email est transmis pour le signataire client', async () => {
    await send(contractId);
    const client = provider.calls[0]!.submitters.find((s) => s.party === 'CLIENT')!;
    expect(client.requireEmail2fa).toBe(true);
  });

  test('la metadata porte le scope — pour le DIAGNOSTIC, jamais l’autorisation', async () => {
    await send(contractId);
    const cmd = provider.calls[0]!;
    expect(cmd.metadata.tenant_id).toBe(fx.tenantId);
    expect(cmd.metadata.customer_id).toBe(fx.customerA.id);
  });

  test('la demande porte une date d’expiration', async () => {
    // Évite les demandes de signature zombies.
    await send(contractId);
    expect(provider.calls[0]!.expireAt).toBeInstanceOf(Date);
  });
});

// ===========================================================================
// §11.2 — le PDF et son empreinte
// ===========================================================================

describe('§11.2 — génération du document', () => {
  test('le SHA-256 est calculé AVANT l’envoi et stocké', async () => {
    // C'est ce qui permet d'affirmer plus tard « le document envoyé est
    // exactement celui-ci ». Sans hash pré-envoi, on ne prouve que ce que
    // DocuSeal veut bien nous dire.
    await send(contractId);

    const v = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractVersion.findUnique({ where: { id: versionId } }),
    );
    expect(v!.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v!.pdfObjectKey).toBeTruthy();
  });

  test('la clé de stockage porte le scope dans son chemin', async () => {
    await send(contractId);
    const v = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractVersion.findUnique({ where: { id: versionId } }),
    );
    // s3://.../t/{tenant}/c/{customer}/contracts/{id}/... (§10.7)
    expect(v!.pdfObjectKey).toContain(`t/${fx.tenantId}/c/${fx.customerA.id}/`);
  });

  test('le PDF envoyé au provider est celui qui a été haché', async () => {
    await send(contractId);
    const cmd = provider.calls[0]!;
    const v = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.contractVersion.findUnique({ where: { id: versionId } }),
    );
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(cmd.pdf).digest('hex')).toBe(v!.pdfSha256);
  });
});

// ===========================================================================
// Cloisonnement
// ===========================================================================

describe('cloisonnement', () => {
  test('envoyer le contrat d’un autre client → 404, aucun appel au provider', async () => {
    const res = await send(fx.customerB.contractId);
    expect(res.status).toBe(404);
    expect(provider.calls).toHaveLength(0);
  });
});
