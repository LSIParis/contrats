import {
  contractStatusLabel,
  signerStatusLabel,
  reminderStatusLabel,
  partyLabel,
} from '../lib/labels.js';

test('les statuts de contrat sont traduits en français', () => {
  expect(contractStatusLabel('ACTIVE')).toBe('Actif');
  expect(contractStatusLabel('PENDING_SIGNATURE')).toBe('En attente de signature');
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
