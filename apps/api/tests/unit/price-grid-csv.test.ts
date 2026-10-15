import { describe, expect, test } from 'vitest';
import { formatGridCsv, parseGridCsv } from '../../src/contract-kinds/price-grid-csv.js';

const months = new Set([0, 12, 24, 36]);
const csv = (...lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf8');

describe('CSV de grille tarifaire', () => {
  test('libellés ou codes, virgule ou point décimal, cellules entre guillemets', () => {
    const { rows, errors } = parseGridCsv(
      csv(
        '﻿Code;Libellé;Description;Unité;Périodicité;TVA;E12;achat_E12;E36',
        'TIP-0001;"Poste ; SIP";"Ligne ""premium""";par poste;Mensuelle;5,5;4,90;3.2;',
        ';Forfait mise en service;;FLAT;ONE_OFF;20;150;;150',
      ),
      months,
      'TIP',
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ code: 'TIP-0001', label: 'Poste ; SIP', description: 'Ligne "premium"', unit: 'PER_DEVICE', recurrence: 'MONTHLY', vatRatePercent: '5.5' });
    expect(Object.fromEntries(rows[0]!.prices)).toEqual({ 12: { unitPrice: '4.90', purchasePrice: '3.2' }, 36: { unitPrice: null, purchasePrice: null } });
    expect(rows[1]).toMatchObject({ code: null, unit: 'FLAT', recurrence: 'ONE_OFF' });
  });

  test('erreurs collectées : code d\'un autre type, doublon, unité, TVA, achat sans vente', () => {
    const { errors } = parseGridCsv(
      csv(
        'code;libelle;unite;periodicite;tva;E12;achat_E12',
        'MNT-0001;A;par poste;mensuelle;20;1;',
        'TIP-0002;B;par poste;mensuelle;20;1;',
        'TIP-0002;C;par lune;mensuelle;120;;2',
      ),
      months,
      'TIP',
    );
    expect(errors.map((e) => e.line)).toEqual([2, 4, 4, 4, 4]);
    expect(errors.map((e) => e.message).join(' | ')).toMatch(/pas un code de base du type TIP.*déjà présent ligne 3.*Unité.*TVA.*achat sans prix de vente/);
  });

  test('export : formules neutralisées, virgule décimale, durée non proposée vide', () => {
    const out = formatGridCsv([0, 12], [{
      code: 'HM-0001', label: '=HYPERLINK("x")', description: null, unit: 'PER_HOUR', recurrence: 'ONE_OFF', vatRatePercent: '20',
      prices: new Map([[12, { unitPrice: '95.5', purchasePrice: null }]]),
    }]);
    expect(out.split('\r\n')[1]).toBe(`HM-0001;"'=HYPERLINK(""x"")";;heure;ponctuelle;20;;95,5;;`);
  });
});
