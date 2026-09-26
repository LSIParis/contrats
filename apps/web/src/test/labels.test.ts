import {
  contractStatusLabel,
  signerStatusLabel,
  reminderStatusLabel,
  partyLabel,
  CONTRACT_STATUS_CODES,
} from '../lib/labels.js';

test('les statuts de contrat sont traduits en français', () => {
  expect(contractStatusLabel('ACTIVE')).toBe('Actif');
  // Libellé aligné sur la liste de référence des statuts (« En signature »).
  expect(contractStatusLabel('PENDING_SIGNATURE')).toBe('En signature');
  expect(contractStatusLabel('DRAFT')).toBe('Brouillon');
});

test('les statuts de signataire et de rappel sont traduits', () => {
  expect(signerStatusLabel('SIGNED')).toBe('Signé');
  expect(signerStatusLabel('SENT')).toBe('Envoyé');
  expect(reminderStatusLabel('PENDING')).toBe('En attente');
  expect(reminderStatusLabel('SKIPPED_OBSOLETE')).toBe('Ignoré (obsolète)');
});

test('la partie CLIENT est traduite, LSI reste LSI', () => {
  expect(partyLabel('CLIENT')).toBe('Client');
  expect(partyLabel('LSI')).toBe('LSI');
});

test('une valeur inconnue retombe sur la valeur brute (jamais undefined)', () => {
  expect(contractStatusLabel('WAT')).toBe('WAT');
  expect(signerStatusLabel('WAT')).toBe('WAT');
});

test('les 20 statuts du cycle de vie ont un libellé français (jamais le code brut)', () => {
  expect(CONTRACT_STATUS_CODES).toHaveLength(20);
  for (const code of CONTRACT_STATUS_CODES) expect(contractStatusLabel(code)).not.toBe(code);
  expect(contractStatusLabel('IMPORTED_PENDING_VALIDATION')).toBe('Importé à valider');
  expect(contractStatusLabel('RENEWAL_DUE')).toBe('À renouveler');
  expect(contractStatusLabel('SIGNATURE_EXPIRED')).toBe('Signature expirée');
});
