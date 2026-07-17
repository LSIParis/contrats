import { describe, test, expect } from 'vitest';
import { DocusealAdapter } from '../../src/signature/docuseal.adapter.js';
import { GotenbergRenderer } from '../../src/documents/gotenberg.renderer.js';
import type { CreateSubmissionCommand } from '@lsi/domain';

/**
 * Test d'INTÉGRATION : mon adaptateur réel contre la VRAIE DocuSeal Enterprise.
 *
 * C'est le sens app → DocuSeal (créer une demande de signature). Il valide ce
 * qu'aucun fake ne peut : que l'EE réelle accepte le payload que je construis,
 * et que je sais lire sa réponse.
 *
 * Précautions, parce que ça écrit dans une prod :
 *   - sendEmail: false            → aucun email réel
 *   - adresses @example.invalid   → rien vers de vrais contacts
 *   - nettoyage : la submission créée est archivée en fin de test
 *
 * Exige DOCUSEAL_API_KEY + DOCUSEAL_URL + Gotenberg local. Ignoré sinon —
 * mais bruyamment (voir Gotenberg test) : un test d'intégration muet est pire
 * qu'absent.
 */

const DS_URL = process.env.DOCUSEAL_URL ?? '';
const DS_KEY = process.env.DOCUSEAL_API_KEY ?? '';
const GOTENBERG = process.env.GOTENBERG_URL ?? 'http://localhost:3003';

const available = await (async () => {
  if (!DS_URL || !DS_KEY) return false;
  try {
    const [ds, got] = await Promise.all([
      fetch(`${DS_URL}/templates?limit=1`, {
        headers: { 'X-Auth-Token': DS_KEY },
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${GOTENBERG}/health`, { signal: AbortSignal.timeout(3000) }),
    ]);
    return ds.ok && got.ok;
  } catch {
    return false;
  }
})();

if (!available) {
  console.warn(
    '\n⚠ DocuSeal EE ou Gotenberg injoignable — test d’intégration app→EE IGNORÉ.' +
      '\n  Requiert DOCUSEAL_URL, DOCUSEAL_API_KEY et `docker compose up -d`.\n',
  );
}

/** Archive une submission de test — on ne laisse pas de déchet en prod. */
async function cleanup(submissionId: string) {
  await fetch(`${DS_URL}/submissions/${submissionId}`, {
    method: 'DELETE',
    headers: { 'X-Auth-Token': DS_KEY },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

describe.runIf(available)('app → DocuSeal EE (instance réelle)', () => {
  test('createSubmission : l’EE accepte le payload de l’adaptateur et je lis sa réponse', async () => {
    const renderer = new GotenbergRenderer();

    // Document AVEC balises de signature, comme le fait désormais le send
    // service : sans elles, pas de champ à signer.
    const { pdf } = await renderer.render({
      html:
        '<h1>Contrat de maintenance — TEST intégration</h1>' +
        '<p>Signature LSI : {{Signature;role=LSI Maintenance;type=signature}}</p>' +
        '<p>Signature client : {{Signature;role=Client;type=signature}}</p>',
      documentTitle: 'LSI-TEST-EE',
    });

    const adapter = new DocusealAdapter();
    const cmd: CreateSubmissionCommand = {
      pdf,
      documentName: 'LSI-TEST-EE.pdf',
      order: 'preserved',
      expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      subject: 'TEST intégration LSI',
      body: 'Ceci est un test automatisé.',
      completedRedirectUrl: 'https://example.invalid/done',
      sendEmail: false, // ← aucun email réel
      submitters: [
        {
          party: 'LSI',
          roleLabel: 'LSI Maintenance',
          externalId: 'lsi-ee-test-signer-lsi',
          fullName: 'Marc D. (test)',
          email: 'lsi-test@example.invalid',
          signingOrder: 0,
          requireEmail2fa: false,
          fields: [],
        },
        {
          party: 'CLIENT',
          roleLabel: 'Client',
          externalId: 'lsi-ee-test-signer-client',
          fullName: 'Client Test',
          email: 'client-test@example.invalid',
          signingOrder: 1,
          requireEmail2fa: false,
          fields: [],
        },
      ],
      metadata: {
        tenant_id: 'ee-test-tenant',
        customer_id: 'ee-test-customer',
        contract_id: 'ee-test-contract',
        signature_request_id: 'ee-test-sr',
      },
    };

    let submission;
    try {
      submission = await adapter.createSubmission(cmd);

      // L'EE a accepté et je sais lire la réponse (le bug objet-vs-tableau).
      expect(submission.providerSubmissionId).toMatch(/^\d+$/);
      expect(submission.submitters).toHaveLength(2);

      // external_id round-trip : c'est la clé de rapprochement des webhooks.
      // Sans elle, on ne saurait pas relier une signature à notre signataire.
      const extIds = submission.submitters.map((s) => s.externalId).sort();
      expect(extIds).toEqual(['lsi-ee-test-signer-client', 'lsi-ee-test-signer-lsi']);

      // Chaque submitter a un slug (l'URL de signature per-signer).
      expect(submission.submitters.every((s) => !!s.slug)).toBe(true);
    } finally {
      if (submission) await cleanup(submission.providerSubmissionId);
    }
  });

  test('findSubmissionByExternalId : le filet anti-double-envoi fonctionne (§11.8)', async () => {
    // Après un timeout, avant de réessayer, on vérifie si la submission
    // existe déjà chez le provider. Ce test crée une submission puis la
    // retrouve par son external_id.
    const renderer = new GotenbergRenderer();
    const { pdf } = await renderer.render({
      html: '<p>Idempotence {{Signature;role=Client;type=signature}}</p>',
      documentTitle: 'LSI-TEST-IDEM',
    });
    const adapter = new DocusealAdapter();
    const ext = 'lsi-ee-idem-' + pdf.length; // varie sans horloge

    let submission;
    try {
      submission = await adapter.createSubmission({
        pdf,
        documentName: 'idem.pdf',
        order: 'preserved',
        expireAt: new Date(Date.now() + 24 * 3600 * 1000),
        subject: 'idem',
        body: 'x',
        completedRedirectUrl: 'https://example.invalid/done',
        sendEmail: false,
        submitters: [
          {
            party: 'CLIENT',
            roleLabel: 'Client',
            externalId: ext,
            fullName: 'Idem Test',
            email: 'idem@example.invalid',
            signingOrder: 0,
            requireEmail2fa: false,
            fields: [],
          },
        ],
        metadata: { tenant_id: 't', customer_id: 'c', contract_id: 'k', signature_request_id: ext },
      });

      const found = await adapter.findSubmissionByExternalId(ext);
      expect(found).not.toBeNull();
      expect(found!.providerSubmissionId).toBe(submission.providerSubmissionId);
    } finally {
      if (submission) await cleanup(submission.providerSubmissionId);
    }
  });
});
