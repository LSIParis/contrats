import { describe, test, expect } from 'vitest';
import {
  assertNoLeak,
  findLeaks,
  pseudonymize,
  reidentify,
  PseudonymizationLeakError,
  type KnownEntities,
} from '../src/pseudonymization/pseudonymize.js';

const KNOWN: KnownEntities = {
  clientNames: ['Acme Industrie SAS', 'Acme'],
  persons: ['Jean-Pierre Dupont', 'Hélène Martin'],
  sirens: ['12345678900012'],
  vatNumbers: ['FR32123456789'],
  addresses: ['12 rue de la Paix, 75002 Paris'],
  emails: ['jp.dupont@acme-industrie.fr'],
  phones: ['01 23 45 67 89'],
  ibans: ['FR76 3000 6000 0112 3456 7890 189'],
};

const SAMPLE = `Entre la société Acme Industrie SAS, SIRET 123 456 789 00012, TVA FR32123456789,
dont le siège est au 12 rue de la Paix, 75002 Paris, représentée par Jean-Pierre Dupont
(jp.dupont@acme-industrie.fr, tél. 01 23 45 67 89), ci-après « Acme ».
Redevance mensuelle : 1 250,00 € HT. Frais de mise en service : 1.250 EUR.
Forfait annuel de 15000 euros HT. IBAN : FR76 3000 6000 0112 3456 7890 189.
Contact comptable : Hélène Martin.`;

describe('pseudonymize — remplacement', () => {
  const { text, map } = pseudonymize(SAMPLE, KNOWN);

  test('aucune valeur sensible ne subsiste', () => {
    for (const v of ['Acme', 'Dupont', 'Hélène', 'Martin', '123 456 789', '12 rue de la Paix', 'Paris', 'jp.dupont', '01 23 45', 'FR76', '1 250,00', '1.250', '15000']) {
      expect(text).not.toContain(v);
    }
    expect(() => assertNoLeak(text, KNOWN)).not.toThrow();
  });

  test('jetons attendus, client principal en [CLIENT]', () => {
    expect(text).toContain('Entre la société [CLIENT]');
    expect(text).toContain('SIRET [SIRET_1]');
    expect(text).toContain('TVA [TVA_1]');
    expect(text).toContain('[ADRESSE_1]');
    expect(text).toContain('représentée par [PERSONNE_1]');
    expect(text).toContain('([EMAIL_1], tél. [TEL_1])');
    expect(text).toContain('ci-après « [CLIENT_2] »');
    expect(text).toContain('[MONTANT_1] HT');
    expect(text).toContain('[MONTANT_2]');
    expect(text).toContain('[MONTANT_3] HT');
    expect(text).toContain('IBAN : [IBAN_1]');
    expect(text).toContain('Contact comptable : [PERSONNE_2]');
    expect(map['[CLIENT]']).toBe('Acme Industrie SAS');
  });

  test('HT / TTC restent hors du jeton', () => {
    expect(text).toMatch(/\[MONTANT_\d+\] HT/);
  });

  test('réversible : reidentify restitue le texte exact', () => {
    expect(reidentify(text, map)).toBe(SAMPLE);
  });

  test('déterministe : deux appels donnent le même résultat', () => {
    expect(pseudonymize(SAMPLE, KNOWN)).toEqual({ text, map });
  });

  test('idempotent : re-pseudonymiser avec la table ne change rien', () => {
    const again = pseudonymize(text, KNOWN, { map });
    expect(again.text).toBe(text);
    expect(again.map).toEqual(map);
  });
});

describe('pseudonymize — formats de montants', () => {
  test.each([
    ['1 250,00 €', '[MONTANT_1]'],
    ['1 250,00 €', '[MONTANT_1]'],
    ['1 250 €', '[MONTANT_1]'],
    ['1.250 EUR', '[MONTANT_1]'],
    ['1250 euros HT', '[MONTANT_1] HT'],
    ['1 euro', '[MONTANT_1]'],
    ['1250.50 €', '[MONTANT_1]'],
    ['15 k€ TTC', '[MONTANT_1] TTC'],
    ['€ 1 250', '[MONTANT_1]'],
    ['125 000 000 €', '[MONTANT_1]'],
    ['40 Euros', '[MONTANT_1]'],
  ])('%s → %s', (input, expected) => {
    expect(pseudonymize(`Prix : ${input}.`).text).toBe(`Prix : ${expected}.`);
  });

  test('un nombre sans devise n’est pas un montant', () => {
    expect(pseudonymize('Article 12, alinéa 3, délai de 30 jours.').text).toBe('Article 12, alinéa 3, délai de 30 jours.');
  });

  test('« eurosceptique » n’est pas une devise', () => {
    expect(pseudonymize('12 eurosceptiques').text).toBe('12 eurosceptiques');
  });

  test('même montant répété → même jeton ; montants différents → jetons différents', () => {
    const r = pseudonymize('A : 100 €. B : 100 €. C : 200 €.');
    expect(r.text).toBe('A : [MONTANT_1]. B : [MONTANT_1]. C : [MONTANT_2].');
  });
});

describe('pseudonymize — entités connues : casse, accents, bornes de mots', () => {
  test('insensible à la casse et aux accents', () => {
    const r = pseudonymize('HELENE MARTIN et hélène martin et Hélène  Martin', { persons: ['Hélène Martin'] });
    expect(r.text).toBe('[PERSONNE_1] et [PERSONNE_1] et [PERSONNE_1]');
    expect(r.map['[PERSONNE_1]']).toBe('HELENE MARTIN');
  });

  test('accent présent dans le texte mais pas dans l’entité connue', () => {
    expect(pseudonymize('Société Genérale Électrique', { clientNames: ['Generale Electrique'] }).text).toBe('Société [CLIENT]');
  });

  test('ne remplace pas à l’intérieur d’un autre mot', () => {
    const r = pseudonymize('Acme, Acmesoft, SuperAcme et Acme2 ; ACME.', { clientNames: ['Acme'] });
    expect(r.text).toBe('[CLIENT], Acmesoft, SuperAcme et Acme2 ; [CLIENT].');
  });

  test('nom composé : tiret ou espace, retour à la ligne OCR', () => {
    const r = pseudonymize('Jean Pierre Dupont / Jean-Pierre\nDupont', { persons: ['Jean-Pierre Dupont'] });
    expect(r.text).toBe('[PERSONNE_1] / [PERSONNE_1]');
  });

  test('apostrophes typographiques', () => {
    expect(pseudonymize('L’Atelier d’Anne', { clientNames: ["L'Atelier d'Anne"] }).text).toBe('[CLIENT]');
  });

  test('le plus long d’abord : « Dupont SAS » avant la personne « Dupont »', () => {
    const r = pseudonymize('Dupont SAS, représentée par M. Dupont', { clientNames: ['Dupont SAS'], persons: ['Dupont'] });
    expect(r.text).toBe('[CLIENT], représentée par M. [PERSONNE_1]');
  });

  test('un nom connu comme client ET comme personne garde un seul jeton', () => {
    const r = pseudonymize('Martin et MARTIN', { clientNames: ['Martin'], persons: ['Martin'] });
    expect(r.text).toBe('[CLIENT] et [CLIENT]');
  });

  test('un client nommé « Client » ne corrompt pas le jeton [CLIENT]', () => {
    const r = pseudonymize('Client et client', { clientNames: ['Client'] });
    expect(r.text).toBe('[CLIENT] et [CLIENT]');
    expect(pseudonymize(r.text, { clientNames: ['Client'] }, { map: r.map }).text).toBe(r.text);
  });

  test('valeurs vides ou trop courtes ignorées', () => {
    expect(pseudonymize('A et B', { clientNames: ['', ' ', 'A'] }).text).toBe('A et B');
  });
});

describe('pseudonymize — identifiants et coordonnées', () => {
  test('SIREN connu, écrit avec espaces ou points ; SIREN dérivé d’un SIRET connu', () => {
    const r = pseudonymize('RCS Paris 123.456.789 — SIREN 123 456 789', { sirens: ['12345678900012'] });
    expect(r.text).toBe('RCS Paris [SIREN_1] — SIREN [SIREN_1]');
  });

  test('SIREN dérivé d’un n° de TVA connu', () => {
    expect(pseudonymize('SIREN 123456789', { vatNumbers: ['FR 32 123 456 789'] }).text).toBe('SIREN [SIREN_1]');
  });

  test('SIREN/SIRET inconnus détectés par motif', () => {
    expect(pseudonymize('SIRET 987 654 321 00034, SIREN 987654321').text).toBe('SIRET [SIRET_1], SIREN [SIREN_1]');
  });

  test('un nombre de 10 chiffres n’est pas découpé en SIREN', () => {
    expect(pseudonymize('Réf. 1234567890').text).toBe('Réf. 1234567890');
  });

  test('téléphones : national, international, points', () => {
    const r = pseudonymize('01 23 45 67 89 / +33 1 23 45 67 89 / 06.12.34.56.78 / 0033 6 12 34 56 78');
    expect(r.text).toBe('[TEL_1] / [TEL_1] / [TEL_2] / [TEL_2]');
  });

  test('téléphone connu écrit en international', () => {
    expect(findLeaks('+33 (0)1 23 45 67 89', { phones: ['0123456789'] }, { detectPatterns: false })).toHaveLength(1);
  });

  test('e-mail : le nom du client qu’il contient ne le découpe pas', () => {
    const r = pseudonymize('Écrire à contact@acme.fr (Acme).', { clientNames: ['Acme'] });
    expect(r.text).toBe('Écrire à [EMAIL_1] ([CLIENT]).');
  });

  test('IBAN non connu détecté ; TVA non connue détectée', () => {
    const r = pseudonymize('IBAN FR7630006000011234567890189 ; TVA FR 32 123 456 789');
    expect(r.text).toBe('IBAN [IBAN_1] ; TVA [TVA_1]');
  });

  test('adresse détectée par motif, avec code postal et ville', () => {
    const r = pseudonymize('Siège : 4 bis, avenue des Champs-Élysées, 75008 Paris CEDEX 08, France.');
    expect(r.text).toBe('Siège : [ADRESSE_1], France.');
  });

  test('adresse sans ville', () => {
    expect(pseudonymize('Livraison au 27 allée des Tilleuls ; accès par le parking.').text).toBe(
      'Livraison au [ADRESSE_1] ; accès par le parking.',
    );
  });

  test('personne introduite par une civilité ou « représentée par »', () => {
    const r = pseudonymize('Mme Claire Fontaine signe. La société, représentée par Paul Durand, accepte. Monsieur le Directeur approuve.');
    expect(r.text).toBe('Mme [PERSONNE_1] signe. La société, représentée par [PERSONNE_2], accepte. Monsieur le Directeur approuve.');
  });
});

describe('table partagée entre plusieurs champs', () => {
  test('les jetons restent cohérents d’un champ à l’autre', () => {
    const a = pseudonymize('Client : Acme, 100 €', { clientNames: ['Acme'] });
    const b = pseudonymize('Rappel : ACME paiera 200 € puis 100 €', { clientNames: ['Acme'] }, { map: a.map });
    expect(b.text).toBe('Rappel : [CLIENT] paiera [MONTANT_2] puis [MONTANT_1]');
    expect(reidentify(b.text, b.map)).toBe('Rappel : Acme paiera 200 € puis 100 €');
  });
});

describe('reidentify', () => {
  test('jeton inconnu laissé tel quel', () => {
    expect(reidentify('[CLIENT] / [MONTANT_9]', { '[CLIENT]': 'Acme' })).toBe('Acme / [MONTANT_9]');
  });

  test('échappement HTML optionnel', () => {
    expect(reidentify('<p>[CLIENT]</p>', { '[CLIENT]': 'A&B <script>' }, { escapeHtml: true })).toBe('<p>A&amp;B &lt;script&gt;</p>');
  });
});

describe('assertNoLeak', () => {
  test('lève si une entité connue subsiste, sans divulguer la valeur', () => {
    let err: unknown;
    try {
      assertNoLeak('Le client Acme Industrie SAS', KNOWN);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PseudonymizationLeakError);
    expect((err as Error).message).not.toContain('Acme');
    expect((err as PseudonymizationLeakError).leaks[0]).toMatchObject({ kind: 'CLIENT', source: 'known', offset: 10 });
  });

  test('lève sur un motif sensible (e-mail, montant) même sans entité connue', () => {
    expect(() => assertNoLeak('écrire à x@y.fr')).toThrow(PseudonymizationLeakError);
    expect(() => assertNoLeak('Prix 1 000 €')).toThrow(PseudonymizationLeakError);
  });

  test('detectPatterns: false ne vérifie que les entités connues', () => {
    expect(() => assertNoLeak('Prix 1 000 €', {}, { detectPatterns: false })).not.toThrow();
  });

  test('les jetons eux-mêmes ne sont jamais des fuites', () => {
    expect(() => assertNoLeak('[CLIENT] [MONTANT_1] [SIREN_1] [EMAIL_2]', { clientNames: ['Client'] })).not.toThrow();
  });

  test('un SIREN fuité au milieu d’un SIRET est détecté', () => {
    expect(() => assertNoLeak('n° 123 456 789', { sirens: ['12345678900012'] }, { detectPatterns: false })).toThrow();
  });

  test('invariant : la sortie de pseudonymize passe toujours le garde-fou', () => {
    const texts = [
      SAMPLE,
      'Contact : M. Paul Durand, 06 12 34 56 78, paul@durand.fr, 3 impasse Verte 69001 Lyon, 2 500 € TTC.',
      'Montant : 1 250 000 000 € pour SIREN 111 222 333 et SIRET 11122233300015.',
    ];
    for (const t of texts) {
      expect(() => assertNoLeak(pseudonymize(t, KNOWN).text, KNOWN)).not.toThrow();
    }
  });
});
