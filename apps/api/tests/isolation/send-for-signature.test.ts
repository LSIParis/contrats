import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { ESIGNATURE_PROVIDER } from '../../src/signature/provider.token.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { FakeProvider, FakeRenderer } from '../support/fakes.js';
import { DocusealReadiness } from '../../src/signature/docuseal-readiness.service.js';
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

  app = await createTestApp(mod);

  fx = await seedTwoCustomers();
  // Signature électronique activée pour ce tenant (désactivée par défaut, brief).
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.tenantFeatureFlag.create({ data: { tenantId: fx.tenantId, key: 'contrats.docuseal.enabled', enabled: true, updatedAt: new Date() } }),
  );

  await app.get(SessionService).put({
    sessionId: SESS_AM_A,
    userId: fx.amUserId,
    tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'],
    scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId),
  });
});

/**
 * Un contrat APPROVED, prêt à partir, avec ses signataires DÉFINIS
 * (`ContractSigner`). Neuf à chaque test.
 */
async function seedApprovedContract(
  over: Record<string, unknown> = {},
  signers: { party: 'LSI' | 'CLIENT'; fullName: string; email: string; signingOrder: number }[] = [
    { party: 'LSI', fullName: 'Marc D.', email: 'direction@lsi.fr', signingOrder: 0 },
    { party: 'CLIENT', fullName: 'J. Dupont', email: 'j.dupont@dupont.fr', signingOrder: 1 },
  ],
) {
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
    if (signers.length) {
      await tx.contractSigner.createMany({
        data: signers.map((s) => ({
          id: uuidv7(),
          tenantId: fx.tenantId,
          customerId: fx.customerA.id,
          contractId: id,
          party: s.party,
          fullName: s.fullName,
          email: s.email,
          signingOrder: s.signingOrder,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        })),
      });
    }
  });
  return { id, versionId: vId };
}

const body = () => ({}); // défauts serveur ; ni signers, ni options

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
    const { id } = await seedApprovedContract({}, [
      { party: 'LSI', fullName: 'Marc D.', email: 'direction@lsi.fr', signingOrder: 0 },
    ]);
    const res = await send(id);
    expect(res.status).toBe(422);
    expect(provider.calls).toHaveLength(0);
  });

  test('envoyer sans signataire LSI → 422', async () => {
    const { id } = await seedApprovedContract({}, [
      { party: 'CLIENT', fullName: 'J. Dupont', email: 'j@d.fr', signingOrder: 0 },
    ]);
    const res = await send(id);
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

  test('ordre par défaut : le client, puis LSI-Maintenance (brief §7, paramètre du tenant)', async () => {
    await send(contractId);
    const cmd = provider.calls[0]!;
    expect(cmd.signingOrder).toBe('CLIENT_THEN_LSI');
    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.findFirst({ where: { contractId }, orderBy: { createdAt: 'desc' } }));
    expect(sr).toMatchObject({ signingOrder: 'CLIENT_THEN_LSI', delivery: 'EMAIL', mode: 'PDF' });
  });

  test('ordre et remise choisis à l’envoi : LSI d’abord, signature intégrée', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/contracts/${contractId}/send-for-signature`)
      .set('x-lsi-session', SESS_AM_A).set('Idempotency-Key', uuidv7())
      .send({ ...(body() as object), signingOrder: 'LSI_THEN_CLIENT', delivery: 'EMBEDDED' });
    expect(res.status).toBe(202);
    expect(provider.calls[0]).toMatchObject({ signingOrder: 'LSI_THEN_CLIENT', delivery: 'EMBEDDED' });
  });

  test('le PDF figé envoyé est référencé (CONTRACT_PDF) et son empreinte portée par la demande', async () => {
    await send(contractId);
    const [sr, doc, events] = await withScope(adminScope(fx.tenantId, fx.adminUserId), async (tx) => [
      await tx.signatureRequest.findFirst({ where: { contractId }, orderBy: { createdAt: 'desc' } }),
      await tx.storedDocument.findFirst({ where: { contractId, kind: 'CONTRACT_PDF' } }),
      await tx.lifecycleEvent.findMany({ where: { contractId }, orderBy: { seq: 'asc' } }),
    ]);
    expect(doc!.sha256).toBe(sr!.sentPdfSha256);
    expect(events.at(-1)).toMatchObject({ fromStatus: 'APPROVED', toStatus: 'PENDING_SIGNATURE', event: 'SEND_FOR_SIGNATURE' });
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
    expect(renderer.lastHtml).toContain('{{Signature LSI Maintenance;role=LSI Maintenance;type=signature;');
    expect(renderer.lastHtml).toContain('{{Signature Client;role=Client;type=signature;');
    // Date de signature automatique (datenow), non antidatable.
    expect(renderer.lastHtml).toContain('{{Date Client;role=Client;type=datenow;');
    expect(provider.calls[0]!.submitters.every((s) => s.fields.length === 0)).toBe(true);
  });

  test('l’empreinte du PDF rendu accompagne la commande (revérifiée par l’adaptateur)', async () => {
    await send(contractId);
    const cmd = provider.calls[0]!;
    expect(cmd.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(cmd.pdf).digest('hex')).toBe(cmd.pdfSha256);
  });

  test('paraphe de chaque page : seulement si DOCUSEAL_INITIALS_FOOTER=true ; référence et pagination toujours', async () => {
    delete process.env.DOCUSEAL_INITIALS_FOOTER;
    await send(contractId);
    // Pied de page v2 : référence + « page X / Y » sur chaque page, SANS balise de paraphe.
    expect(renderer.lastFooter).toContain('<span class="pageNumber"></span>');
    expect(renderer.lastFooter).toContain('<span class="totalPages"></span>');
    expect(renderer.lastFooter).not.toContain('type=initials');
  });

  test('paraphe activé : un paraphe par rôle, numéro de page du moteur', async () => {
    process.env.DOCUSEAL_INITIALS_FOOTER = 'true';
    try {
      await send(contractId);
    } finally {
      delete process.env.DOCUSEAL_INITIALS_FOOTER;
    }
    expect(renderer.lastFooter).toContain('{{Paraphe Client p<span class="pageNumber"></span>;role=Client;type=initials');
    expect(renderer.lastFooter).toContain('{{Paraphe LSI Maintenance p<span class="pageNumber"></span>;');
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

describe('disponibilité effective de la signature (drapeau + sonde DocuSeal)', () => {
  test('drapeau désactivé → 503 DOCUSEAL_DISABLED, rien n’est créé', async () => {
    const { id } = await seedApprovedContract();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.tenantFeatureFlag.update({ where: { tenantId_key: { tenantId: fx.tenantId, key: 'contrats.docuseal.enabled' } }, data: { enabled: false } }));
    try {
      const before = provider.calls.length;
      const res = await send(id);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code).toBe('DOCUSEAL_DISABLED');
      expect(provider.calls.length).toBe(before);
    } finally {
      await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
        tx.tenantFeatureFlag.update({ where: { tenantId_key: { tenantId: fx.tenantId, key: 'contrats.docuseal.enabled' } }, data: { enabled: true } }));
    }
  });

  test('instance injoignable → 503 DOCUSEAL_UNAVAILABLE (la signature est neutralisée, pas l’application)', async () => {
    const { id } = await seedApprovedContract();
    const original = provider.checkReadiness.bind(provider);
    provider.checkReadiness = async () => ({ reachable: false, tokenValid: false, detail: 'down' });
    const readiness = app.get(DocusealReadiness);
    await readiness.refresh();
    try {
      const res = await send(id);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code).toBe('DOCUSEAL_UNAVAILABLE');
      await request(app.getHttpServer()).get('/healthz').expect(200);
    } finally {
      provider.checkReadiness = original;
      await readiness.refresh();
    }
  });
});
