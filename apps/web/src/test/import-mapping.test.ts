import { endDateFromDuration, prefill, toPayload, confidenceLevel, type ImportView } from '../features/imports/import-mapping.js';

function view(extraction: ImportView['extraction'], contract: Partial<ImportView['contract']> = {}): ImportView {
  return {
    contract: {
      id: 'k1', reference: 'IMP-2026-0001', title: 'Contrat Dupont', status: 'IMPORTED_PENDING_VALIDATION',
      category: 'MAINTENANCE', customerId: 'c1', startDate: null, endDate: null, signedAt: null,
      noticePeriodDays: null, noticePeriodMonths: null, renewalMode: 'NONE', renewalPeriodMonths: null,
      amountCents: null, billingFrequency: 'MONTHLY', ...contract,
    },
    origin: 'LEGACY_IMPORT',
    signatureMode: 'EXTERNAL_WET_SIGNATURE',
    original: { id: 'd1', filename: 'dupont.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'ab', createdAt: '2026-09-01T10:00:00Z', uploadedByUserId: 'u1' },
    ocr: { status: 'DONE', attempts: 1, pages: 3, error: null, searchablePdf: null },
    extraction,
    extractionMethod: 'RULES',
    validated: null,
  };
}
const f = (value: unknown, confidence = 0.9) => ({ value, confidence, evidence: { excerpt: 'x', offset: 0 }, method: 'RULES' });

test('terme = date d’effet + N mois − 1 jour (fin de mois ramenée)', () => {
  expect(endDateFromDuration('2024-01-01', 12)).toBe('2024-12-31');
  expect(endDateFromDuration('2025-03-15', 36)).toBe('2028-03-14');
  expect(endDateFromDuration('2024-01-31', 1)).toBe('2024-02-28');
  expect(endDateFromDuration('', 12)).toBe('');
  expect(endDateFromDuration('2024-01-01', 0)).toBe('');
});

test('pré-remplissage : durée → terme calculé, préavis en mois, reconduction tacite, montant annuel', () => {
  const { form, sources } = prefill(view({
    dateEffet: f('2026-01-01'),
    dateSignature: f('2025-12-15'),
    dureeMois: f(12),
    preavis: f({ quantite: 3, unite: 'MOIS' }),
    reconduction: f('TACITE'),
    montantAnnuelHtCentimes: f(1_200_000),
  }));
  expect(form.startDate).toBe('2026-01-01');
  expect(form.signedAt).toBe('2025-12-15');
  expect(form.endDate).toBe('2026-12-31');
  expect(sources.endDate?.derived).toMatch(/\+ 12 mois − 1 jour/);
  expect(form.noticeQuantity).toBe('3');
  expect(form.noticeUnit).toBe('MOIS');
  expect(form.renewalMode).toBe('TACIT');
  expect(form.renewalPeriodMonths).toBe('12');
  expect(form.amount).toBe('12000,00');
  expect(form.billingFrequency).toBe('YEARLY');
});

test('pré-remplissage : dateFin explicite prioritaire, préavis en jours, EXPRESSE/AUCUNE, montant mensuel', () => {
  const a = prefill(view({
    dateEffet: f('2026-01-01'), dateFin: f('2027-06-30'), dureeMois: f(12),
    preavis: f({ quantite: 90, unite: 'JOURS' }), reconduction: f('EXPRESSE'), montantMensuelHtCentimes: f(150_050),
  }));
  expect(a.form.endDate).toBe('2027-06-30');
  expect(a.form.noticeQuantity).toBe('90');
  expect(a.form.noticeUnit).toBe('JOURS');
  expect(a.form.renewalMode).toBe('EXPRESS');
  expect(a.form.amount).toBe('1500,50');
  expect(a.form.billingFrequency).toBe('MONTHLY');
  expect(prefill(view({ reconduction: f('AUCUNE') })).form.renewalMode).toBe('NONE');
});

test('pré-remplissage : montant saisi au dépôt (montantCentimes) et extraction absente', () => {
  const a = prefill(view({ montantCentimes: { value: 50_000, confidence: 1, evidence: null, method: 'SAISIE' } }));
  expect(a.form.amount).toBe('500,00');
  const b = prefill(view(null, { startDate: '2025-02-01T00:00:00.000Z', noticePeriodMonths: 2 }));
  expect(b.form.startDate).toBe('2025-02-01');
  expect(b.form.noticeQuantity).toBe('2');
  expect(b.form.noticeUnit).toBe('MOIS');
});

test('corps de validation : unités de préavis, champs vides omis', () => {
  const base = prefill(view(null)).form;
  const r = toPayload({ ...base, startDate: '2026-01-01', noticeQuantity: '3', noticeUnit: 'MOIS', amount: '' });
  expect(r.payload).toEqual({ startDate: '2026-01-01', renewalMode: 'NONE', title: 'Contrat Dupont', category: 'MAINTENANCE', noticePeriodMonths: 3 });
  const d = toPayload({ ...base, startDate: '2026-01-01', noticeQuantity: '30', noticeUnit: 'JOURS' });
  expect(d.payload?.noticePeriodDays).toBe(30);
  expect(d.payload?.noticePeriodMonths).toBeUndefined();
});

test('contrôles locaux : date d’effet, terme antérieur, reconduction sans durée, montant', () => {
  const base = prefill(view(null)).form;
  expect(toPayload(base).errors.startDate).toBeDefined();
  expect(toPayload({ ...base, startDate: '2026-02-01', endDate: '2026-01-01' }).errors.endDate).toBeDefined();
  expect(toPayload({ ...base, startDate: '2026-02-01', renewalMode: 'TACIT' }).errors.renewalPeriodMonths).toBeDefined();
  expect(toPayload({ ...base, startDate: '2026-02-01', amount: 'abc' }).errors.amount).toBeDefined();
});

test('niveaux de confiance : texte associé à chaque ton', () => {
  expect(confidenceLevel(0.95)).toEqual({ tone: 'success', label: 'élevée' });
  expect(confidenceLevel(0.6)).toEqual({ tone: 'warn', label: 'moyenne' });
  expect(confidenceLevel(0.2)).toEqual({ tone: 'danger', label: 'faible' });
});
