import { describe, test, expect } from 'vitest';
import {
  buildTextTag,
  signatureTag,
  signingDateTag,
  initialsTag,
  initialsFooterHtml,
  hiddenTagHtml,
  signerRoleLabel,
  TextTagError,
  planSigningOrder,
  resolveSigningPolicy,
  linkDocumentHashes,
  DocumentHashError,
  ProviderError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderValidationError,
  ProviderUnavailableError,
  type SubmitterCommand,
} from '../src/index.js';

/**
 * Helpers purs de la voie nominale DocuSeal (06-docuseal.md).
 *
 * La grammaire des balises est vérifiée contre la documentation DocuSeal
 * (2026-09-26) : `{{Nom;role=…;type=…}}`. Ce qui se teste ici, c'est que
 * NOUS la produisons correctement — et qu'on ne peut pas l'injecter.
 */

describe('balises textuelles', () => {
  test('signature : nom distinct par rôle, rôle apparié, taille fixée', () => {
    expect(signatureTag('Client')).toBe('{{Signature Client;role=Client;type=signature;width=180;height=60}}');
  });

  test('date de signature : datenow (auto, non modifiable), format français', () => {
    expect(signingDateTag('LSI Maintenance')).toBe(
      '{{Date LSI Maintenance;role=LSI Maintenance;type=datenow;format=DD/MM/YYYY;width=90;height=18}}',
    );
  });

  test('paraphe : un champ distinct par page', () => {
    expect(initialsTag('Client', 3)).toBe('{{Paraphe Client p3;role=Client;type=initials;width=48;height=24}}');
    expect(initialsTag('Client', 1)).not.toBe(initialsTag('Client', 2));
  });

  test('paraphe de gabarit : le numéro de page est un fragment remplacé au rendu', () => {
    const tag = initialsTag('Client', '<span class="pageNumber"></span>');
    expect(tag).toBe(
      '{{Paraphe Client p<span class="pageNumber"></span>;role=Client;type=initials;width=48;height=24}}',
    );
  });

  test('le libellé de rôle est la source unique partagée balise ↔ submitter', () => {
    expect(signerRoleLabel('CLIENT')).toBe('Client');
    expect(signerRoleLabel('LSI')).toBe('LSI Maintenance');
    expect(signatureTag(signerRoleLabel('CLIENT'))).toContain('role=Client;');
  });

  test.each([
    ['Client;readonly=true', 'injection d’attribut'],
    ['Client}}{{X', 'fermeture de balise'],
    ['Cli=ent', 'signe égal'],
    ['<b>Client</b>', 'HTML'],
    [' Client', 'espace de tête'],
    ['', 'vide'],
  ])('rôle refusé : %s (%s)', (role) => {
    expect(() => signatureTag(role)).toThrow(TextTagError);
  });

  test('attributs optionnels et validation des dimensions', () => {
    expect(buildTextTag({ name: 'Mention', role: 'Client', type: 'text', required: false, readonly: true })).toBe(
      '{{Mention;role=Client;type=text;required=false;readonly=true}}',
    );
    expect(() => buildTextTag({ name: 'X', role: 'Client', type: 'text', width: 0 })).toThrow(TextTagError);
    expect(() => buildTextTag({ name: 'X', role: 'Client', type: 'date', format: 'DD;role=LSI' })).toThrow(TextTagError);
  });

  test('balise cachée : texte blanc et insécable (une balise coupée n’est plus reconnue)', () => {
    const html = hiddenTagHtml(signatureTag('Client'));
    expect(html).toContain('color:#ffffff');
    expect(html).toContain('white-space:nowrap');
    expect(html).toContain('{{Signature Client;role=Client;type=signature;width=180;height=60}}');
  });

  test('pied de page : un paraphe par rôle, numéro de page Chromium', () => {
    const footer = initialsFooterHtml(['Client', 'LSI Maintenance']);
    expect(footer).toContain('{{Paraphe Client p<span class="pageNumber"></span>;role=Client;type=initials');
    expect(footer).toContain('{{Paraphe LSI Maintenance p<span class="pageNumber"></span>;role=LSI Maintenance;');
    expect(footer).toContain('font-size:7pt'); // taille explicite : défaut Chromium quasi nul
    expect(() => initialsFooterHtml([])).toThrow(TextTagError);
  });
});

function signer(party: 'LSI' | 'CLIENT', externalId: string, signingOrder: number): SubmitterCommand {
  return {
    party,
    roleLabel: signerRoleLabel(party),
    externalId,
    fullName: externalId,
    email: `${externalId}@example.invalid`,
    signingOrder,
    requireEmail2fa: false,
    fields: [],
  };
}

describe('ordre de signature', () => {
  const lsi = signer('LSI', 'lsi', 0);
  const client = signer('CLIENT', 'cli', 1);

  test('défaut du brief : client puis LSI', () => {
    expect(resolveSigningPolicy({})).toBe('CLIENT_THEN_LSI');
    const plan = planSigningOrder([lsi, client], 'CLIENT_THEN_LSI');
    expect(plan.order).toBe('preserved');
    expect(plan.submitters.map((s) => [s.externalId, s.signingOrder])).toEqual([
      ['cli', 0],
      ['lsi', 1],
    ]);
  });

  test('LSI puis client (RM-13 historique)', () => {
    const plan = planSigningOrder([client, lsi], 'LSI_THEN_CLIENT');
    expect(plan.submitters.map((s) => [s.externalId, s.signingOrder])).toEqual([
      ['lsi', 0],
      ['cli', 1],
    ]);
  });

  test('parallèle : tous invités d’emblée (order random)', () => {
    const plan = planSigningOrder([lsi, client], 'PARALLEL');
    expect(plan.order).toBe('random');
    expect(plan.submitters.every((s) => s.signingOrder === 0)).toBe(true);
  });

  test('appelant historique (order preserved) : l’ordre saisi est respecté', () => {
    expect(resolveSigningPolicy({ order: 'preserved' })).toBe('AS_DEFINED');
    expect(resolveSigningPolicy({ order: 'random' })).toBe('PARALLEL');
    expect(resolveSigningPolicy({ order: 'preserved', signingOrder: 'LSI_THEN_CLIENT' })).toBe('LSI_THEN_CLIENT');
    const plan = planSigningOrder([client, lsi], 'AS_DEFINED');
    expect(plan.submitters.map((s) => s.externalId)).toEqual(['lsi', 'cli']);
  });

  test('deux signataires client de même rang restent un groupe parallèle', () => {
    const c1 = signer('CLIENT', 'c1', 5);
    const c2 = signer('CLIENT', 'c2', 5);
    const c3 = signer('CLIENT', 'c3', 7);
    const plan = planSigningOrder([lsi, c3, c2, c1], 'CLIENT_THEN_LSI');
    expect(plan.submitters.map((s) => [s.externalId, s.signingOrder])).toEqual([
      ['c2', 0],
      ['c1', 0],
      ['c3', 1],
      ['lsi', 2],
    ]);
  });

  test('aucun signataire → erreur', () => {
    expect(() => planSigningOrder([], 'CLIENT_THEN_LSI')).toThrow();
  });
});

describe('lien d’empreintes envoyé ↔ signé', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);

  test('empreintes différentes : surcouche de signature, les deux conservées', () => {
    expect(linkDocumentHashes(a, b)).toEqual({ sentSha256: a, signedSha256: 'b'.repeat(64), relation: 'SIGNED_OVERLAY' });
  });

  test('octets identiques : IDENTICAL (normalisation de casse)', () => {
    expect(linkDocumentHashes(a, a.toUpperCase()).relation).toBe('IDENTICAL');
  });

  test('empreinte malformée : refusée', () => {
    expect(() => linkDocumentHashes('abc', b)).toThrow(DocumentHashError);
    expect(() => linkDocumentHashes(a, 'z'.repeat(64))).toThrow(DocumentHashError);
  });
});

describe('erreurs typées du provider', () => {
  test('chaque sous-classe porte son code et sa réessayabilité', () => {
    const cases: [ProviderError, string, boolean][] = [
      [new ProviderAuthError('x'), 'AUTH', false],
      [new ProviderValidationError('x', 422, 'Unknown field'), 'VALIDATION', false],
      [new ProviderTimeoutError('x'), 'TIMEOUT', true],
      [new ProviderUnavailableError('x', 503), 'UNAVAILABLE', true],
    ];
    for (const [err, code, retryable] of cases) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
    }
  });

  test('constructeur historique (message, retryable) toujours valide', () => {
    expect(new ProviderError('x', true).code).toBe('UNAVAILABLE');
    expect(new ProviderError('x', false).code).toBe('PROTOCOL');
  });
});
