import { describe, test, expect } from 'vitest';
import { htmlToText, interpretExtraction, knownEntitiesOf, textToHtml } from '../../src/ai-drafting/contract-ai.service.js';
import type { ImportExtractOutput } from '../../src/ai-drafting/drafting-schemas.js';

const none = { value: '', excerpt: '' };
const base: ImportExtractOutput = {
  dateSignature: none, dateEffet: none, dureeMois: none, reconduction: none, preavis: none,
  montantMensuelHt: none, montantAnnuelHt: none, indiceRevision: none,
};
const doc = `Fait à Paris, le 12 mars 2024.
Le présent contrat est conclu pour une durée de 36 mois,
reconduit tacitement, sauf préavis de trois (3) mois. Redevance mensuelle : 1 250,50 € HT. Indice Syntec.`;

describe('interprétation de l’extraction assistée', () => {
  test('valeurs adossées à un extrait exact (espaces normalisés) → retenues, typées', () => {
    const r = interpretExtraction({
      ...base,
      dateSignature: { value: '2024-03-12', excerpt: 'Fait à Paris, le 12 mars 2024' },
      dureeMois: { value: '36', excerpt: 'conclu pour une durée de 36 mois,\n reconduit' },
      reconduction: { value: 'tacite', excerpt: 'reconduit tacitement' },
      preavis: { value: '3 MOIS', excerpt: 'préavis de trois (3) mois' },
      montantMensuelHt: { value: '1 250,50 €', excerpt: 'Redevance mensuelle : 1 250,50 € HT' },
      indiceRevision: { value: 'SYNTEC', excerpt: 'Indice Syntec' },
    }, doc);
    expect(r.dateSignature).toMatchObject({ value: '2024-03-12', method: 'LLM', confidence: 0.6 });
    expect(r.dureeMois).toMatchObject({ value: 36 });
    expect(r.reconduction).toMatchObject({ value: 'TACITE' });
    expect(r.preavis).toMatchObject({ value: { quantite: 3, unite: 'MOIS' } });
    expect(r.montantMensuelHtCentimes).toMatchObject({ value: 125050 });
    expect(r.indiceRevision).toMatchObject({ value: 'SYNTEC' });
  });

  test('extrait introuvable, valeur mal formée ou vide → écartée', () => {
    const r = interpretExtraction({
      ...base,
      dateSignature: { value: '12/03/2024', excerpt: 'Fait à Paris, le 12 mars 2024' },
      dureeMois: { value: '36', excerpt: 'durée de quarante-huit mois' },
      indiceRevision: { value: 'INSEE', excerpt: 'Indice Syntec' },
    }, doc);
    expect(r.dateSignature).toBeNull();
    expect(r.dureeMois).toBeNull();
    expect(r.indiceRevision).toBeNull();
    expect(r.preavis).toBeNull();
  });
});

describe('outils', () => {
  test('HTML ↔ texte : échappement du texte généré', () => {
    expect(htmlToText('<p>Un &amp; deux</p><p>trois<br>quatre</p>')).toBe('Un & deux\ntrois\nquatre');
    expect(textToHtml('a <script>\n\nb')).toBe('<p>a &lt;script&gt;</p><p>b</p>');
  });

  test('entités connues du client : vides écartées, doublons fusionnés', () => {
    const k = knownEntitiesOf(
      { name: 'Acme', legalName: 'Acme', siren: '552100554', vatNumber: null, addressLine1: '1 rue X', addressLine2: '' },
      ['Jean Martin', 'Jean Martin'], [{ email: 'j@acme.fr', phone: null }],
    );
    expect(k).toEqual({ clientNames: ['Acme'], persons: ['Jean Martin'], sirens: ['552100554'], vatNumbers: [], addresses: ['1 rue X'], emails: ['j@acme.fr'], phones: [] });
  });
});
