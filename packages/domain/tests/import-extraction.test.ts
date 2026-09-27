import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractContractMetadata,
  isValidSiren,
  type ExtractedContractMetadata,
} from '../src/import-extraction/extract-metadata.js';
import { findDates, foldSameLength, parseEuroCents, parseQuantity, repairOcr } from '../src/import-extraction/french-parsing.js';

// Les fixtures vivent à la racine du dépôt (test/fixtures/ocr), emplacement imposé par le brief.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'ocr');
const samples = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.txt'))
  .sort();

type Expected = { [K in keyof ExtractedContractMetadata]: unknown };

describe('fixtures OCR (test/fixtures/ocr)', () => {
  test('au moins 4 échantillons variés', () => {
    expect(samples.length).toBeGreaterThanOrEqual(4);
  });

  describe.each(samples)('%s', (file) => {
    // Normalisation des fins de ligne : les fixtures peuvent être extraites en CRLF sous Windows.
    const text = readFileSync(join(FIXTURES, file), 'utf8').replace(/\r\n/g, '\n');
    const expected = JSON.parse(readFileSync(join(FIXTURES, file.replace(/\.txt$/, '.expected.json')), 'utf8')) as Expected;
    const result = extractContractMetadata(text);

    test.each(Object.keys(expected) as (keyof ExtractedContractMetadata)[])('%s', (key) => {
      const got = result[key];
      const want = expected[key];
      if (want === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      expect(got?.value).toEqual(want);
      expect(got?.confidence).toBeGreaterThan(0);
      expect(got?.confidence).toBeLessThanOrEqual(1);
      // La preuve est un extrait EXACT du texte, à la position annoncée.
      const ev = got?.evidence;
      expect(ev).toBeDefined();
      expect(text.slice(ev!.offset, ev!.offset + ev!.excerpt.length)).toBe(ev!.excerpt);
      expect(ev!.excerpt.length).toBeGreaterThan(0);
    });
  });
});

describe('OCR dégradé : la confiance baisse quand la lecture est douteuse', () => {
  const clean = extractContractMetadata(readFileSync(join(FIXTURES, '01-infogerance-propre.txt'), 'utf8').replace(/\r\n/g, '\n'));
  const noisy = extractContractMetadata(readFileSync(join(FIXTURES, '04-ocr-degrade.txt'), 'utf8').replace(/\r\n/g, '\n'));

  test('indice « Syntcc » reconnu mais moins sûr que « SYNTEC »', () => {
    expect(noisy.indiceRevision!.confidence).toBeLessThan(clean.indiceRevision!.confidence);
  });

  test('SIREN à clé de Luhn invalide : confiance réduite', () => {
    expect(noisy.prestataireSiren!.confidence).toBeLessThan(clean.prestataireSiren!.confidence);
  });
});

describe('dates françaises', () => {
  const iso = (s: string) => findDates(foldSameLength(repairOcr(s))).map((d) => d.iso);

  test.each([
    ['1er janvier 2024', '2024-01-01'],
    ['1ᵉʳ janvier 2024', '2024-01-01'],
    ['01/01/2024', '2024-01-01'],
    ['1 janv. 2024', '2024-01-01'],
    ['15 févr. 2023', '2023-02-15'],
    ['3 FÉVRIER 2023', '2023-02-03'],
    ['30 août 2025', '2025-08-30'],
    ['30 aout 2025', '2025-08-30'],
    ['7 sept. 2022', '2022-09-07'],
    ['12 déc. 2021', '2021-12-12'],
    ['07.06.21', '2021-06-07'],
    ['7-6-2021', '2021-06-07'],
    ['2024-03-15', '2024-03-15'],
    ['l5 mars 2O24', '2024-03-15'],
    ['1er ianvier 2024', '2024-01-01'],
  ])('%s → %s', (input, want) => {
    expect(iso(`le ${input}.`)).toEqual([want]);
  });

  test('dates impossibles ignorées', () => {
    expect(iso('le 31/02/2024 et le 32 mars 2024')).toEqual([]);
  });

  test('un numéro de version ou une fraction n’est pas une date', () => {
    expect(iso('version 2021-04, page 1/4, article 3.2.1')).toEqual([]);
  });
});

describe('briques', () => {
  test('repairOcr préserve la longueur et ne touche pas les mots', () => {
    const s = 'Art1cle 2O24 Il l5 3OO,OO € HT l’indice';
    const r = repairOcr(s);
    expect(r).toHaveLength(s.length);
    expect(r).toBe("Art1cle 2024 Il 15 300,00 € HT l'indice");
  });

  test('foldSameLength préserve la longueur', () => {
    const s = 'ÉTÉ Préavis Œuvre';
    expect(foldSameLength(s)).toHaveLength(s.length);
    expect(foldSameLength(s)).toBe('ete preavis œuvre');
  });

  test.each([
    ['1 250,00', 125000],
    ['1.250', 125000],
    ['1250.5', 125050],
    ['12.000', 1200000],
    ['49', 4900],
  ])('parseEuroCents(%s) = %i', (raw, cents) => {
    expect(parseEuroCents(raw)).toBe(cents);
  });

  test.each([
    ['trois', '3', 3],
    ['trente-six', '36', 36],
    ['douze', undefined, 12],
    ['24', undefined, 24],
    ['3', 'trois', 3],
    ['vingt-quatre', undefined, 24],
  ])('parseQuantity(%s, %s) = %i', (main, paren, n) => {
    expect(parseQuantity(main, paren)).toBe(n);
  });

  test('clé de Luhn du SIREN', () => {
    expect(isValidSiren('123456782')).toBe(true);
    expect(isValidSiren('123456789')).toBe(false);
    expect(isValidSiren('12345678')).toBe(false);
  });
});

describe('cas limites', () => {
  test('texte vide : tout est null', () => {
    const r = extractContractMetadata('');
    expect(Object.values(r).every((v) => v === null)).toBe(true);
  });

  test('« sans tacite reconduction » est une absence de reconduction', () => {
    expect(extractContractMetadata('Le contrat est conclu sans tacite reconduction.').reconduction?.value).toBe('AUCUNE');
  });

  test('indices contradictoires : proposé, mais confiance réduite', () => {
    const r = extractContractMetadata('Il est renouvelable par tacite reconduction. Toutefois, pas de reconduction au-delà de 2030.');
    expect(r.reconduction).not.toBeNull();
    expect(r.reconduction!.confidence).toBeLessThan(0.6);
  });

  test('montant TTC seul : pas de montant HT proposé', () => {
    expect(extractContractMetadata('Redevance mensuelle : 1 200 € TTC.').montantMensuelHtCentimes).toBeNull();
  });

  test('durée en années convertie en mois', () => {
    expect(extractContractMetadata('conclu pour une durée ferme de deux (2) ans').dureeMois?.value).toBe(24);
  });

  test('préavis en jours', () => {
    expect(extractContractMetadata('moyennant un préavis de soixante (60) jours').preavis?.value).toEqual({ quantite: 60, unite: 'JOURS' });
  });

  test('prend effet à la signature : reprend la date de signature', () => {
    const r = extractContractMetadata('Le contrat prend effet à compter de sa signature.\nFait à Nantes, le 4 avril 2025.');
    expect(r.dateSignature?.value).toBe('2025-04-04');
    expect(r.dateEffet?.value).toBe('2025-04-04');
    expect(r.dateEffet!.confidence).toBeLessThanOrEqual(0.7);
  });

  test('déterministe', () => {
    const t = readFileSync(join(FIXTURES, samples[0] as string), 'utf8');
    expect(extractContractMetadata(t)).toEqual(extractContractMetadata(t));
  });
});
