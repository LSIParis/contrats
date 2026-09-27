import { SETTING_DEFS, fromInput, toInput } from '../features/settings/settings-page.js';

test('paramètres : toutes les clés proposals.* du tenant sont éditables', () => {
  expect(SETTING_DEFS.map((d) => d.key)).toEqual(expect.arrayContaining([
    'proposals.reviewDiscountPercent', 'proposals.reviewAmountCents', 'proposals.clickAcceptMaxCents', 'proposals.defaultValidityDays',
    'proposals.followUps', 'proposals.trackingRetentionDays', 'proposals.linkGraceDays', 'proposals.emailSubject', 'proposals.emailBody',
    'proposals.lsiSignerUserId',
  ]));
});

test('relances par défaut : « 3, 7, 2 » ↔ objet de l’API', () => {
  const kind = SETTING_DEFS.find((d) => d.key === 'proposals.followUps')!.kind;
  expect(toInput({ noOpenAfterDays: 3, noDecisionAfterDays: 7, beforeExpiryDays: 2 }, kind)).toBe('3, 7, 2');
  expect(fromInput('4, 8, 3', kind)).toEqual({ value: { noOpenAfterDays: 4, noDecisionAfterDays: 8, beforeExpiryDays: 3 } });
  expect(fromInput('4, 8', kind)).toHaveProperty('error');
});

test('texte obligatoire : vide refusé ; texte facultatif : vide → null', () => {
  const subject = SETTING_DEFS.find((d) => d.key === 'proposals.emailSubject')!.kind;
  expect(fromInput('', subject)).toHaveProperty('error');
  expect(fromInput(' Proposition {{proposition.numero}} ', subject)).toEqual({ value: 'Proposition {{proposition.numero}}' });
  const signer = SETTING_DEFS.find((d) => d.key === 'proposals.lsiSignerUserId')!.kind;
  expect(fromInput('', signer)).toEqual({ value: null });
});
