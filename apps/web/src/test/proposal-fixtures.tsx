import { Route, Routes } from 'react-router-dom';
import { ProposalWorkspacePage } from '../features/proposals/proposal-workspace-page.js';
import type { ProposalDetail, Tracking } from '../features/proposals/proposal-api.js';
import { renderWithClient } from './api-mock.js';
import { routeFetch } from './fetch-router.js';

/** Proposition de référence (forme exacte de `GET /v1/proposals/:id`). */
export function detail(over: { proposal?: Partial<ProposalDetail['proposal']> } & Partial<Omit<ProposalDetail, 'proposal'>> = {}): ProposalDetail {
  const { proposal, ...rest } = over;
  const bucket = (ht: string, vat: string, ttc: string) => ({ htCents: ht, vatCents: vat, ttcCents: ttc });
  return {
    proposal: {
      id: 'p-1', number: 'PROP-2026-0007', title: 'Infogérance — Acme', status: 'DRAFT', customerId: 'c-1', ownerUserId: 'u-1',
      templateId: 't-1', acceptanceMode: 'DOCUSEAL_SIGNATURE', validityDays: 30, fixedExpiryDate: null, expiresAt: null,
      sensitive: false, reviewRequired: false, reviewReason: null, followUpsEnabled: true,
      followUpConfig: { noOpenAfterDays: 3, noDecisionAfterDays: 7, beforeExpiryDays: 2 }, mergeContext: { 'parc.nbPostes': 12 },
      winProbability: 50, desiredStartDate: null, conversionError: null, declineReasonCode: null, declineReason: null, withdrawReason: null,
      contractId: null, sentAt: null, firstViewedAt: null, lastActivityAt: null, acceptedAt: null, signedAt: null, convertedAt: null,
      customer: { id: 'c-1', name: 'Acme', legalName: 'Acme SAS', siren: '123456789', commercialStatus: 'PROSPECT' },
      owner: { id: 'u-1', fullName: 'Camille Commerciale', email: 'camille@lsi.fr' },
      ...proposal,
    },
    version: {
      id: 'v-1', number: 1, title: 'Infogérance — Acme', lockedAt: null, supersededAt: null, pdfSha256: null, contentSha256: null,
      terms: { id: 'cgv-3', versionNumber: 3, title: 'CGV 2026' },
      sections: [
        { key: 'couverture', title: 'Couverture', kind: 'COVER', optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, blocks: [{ type: 'RICH_TEXT', content: { markdown: '# Proposition\n\n**{{client.raisonSociale}}**' } }] },
        { key: 'contexte', title: 'Votre contexte', kind: 'CLIENT_INPUT', optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: 'Décrire le parc et les enjeux.', blocks: [{ type: 'RICH_TEXT', content: { markdown: '' } }] },
        { key: 'qui-sommes-nous', title: 'Qui sommes-nous', kind: 'LIBRARY', optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: 'presentation', guidance: null, blocks: [{ type: 'RICH_TEXT', content: { markdown: 'LSI Maintenance, MSP à Aix.', sourceSha256: 'a'.repeat(64) } }] },
        { key: 'niveaux-de-service', title: 'Niveaux de service', kind: 'TEXT', optional: true, excluded: false, validationStatus: 'TO_VALIDATE', libraryItemKey: null, guidance: null, blocks: [{ type: 'RICH_TEXT', content: { markdown: 'Prise en charge sous 4 h.' } }] },
        { key: 'investissement', title: 'Votre investissement', kind: 'PRICING', optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, blocks: [{ type: 'PRICING_TABLE', content: {} }] },
        { key: 'cgv', title: 'Conditions générales de vente', kind: 'TERMS', optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, blocks: [{ type: 'TERMS', content: {} }] },
        { key: 'signature', title: 'Acceptation et signature', kind: 'SIGNATURE', optional: false, excluded: false, validationStatus: 'VALIDATED', libraryItemKey: null, guidance: null, blocks: [{ type: 'SIGNATURE', content: {} }] },
      ],
      pricingDefinition: {
        vatRatePercent: 20,
        choices: [
          { key: 'formule', label: 'Formule', editableByClient: true, options: [{ value: 'essentiel', label: 'Essentiel', default: true }, { value: 'pro', label: 'Pro' }] },
          { key: 'engagement', label: 'Durée d’engagement', editableByClient: true, options: [{ value: '12', label: '12 mois', default: true, commitmentMonths: 12 }, { value: '36', label: '36 mois', commitmentMonths: 36 }] },
        ],
        lines: [
          { key: 'poste', label: 'Poste de travail', kind: 'REQUIRED', unit: 'poste / mois', recurrence: 'MONTHLY', group: 'RECURRING', quantity: { default: '{{parc.nbPostes}}', min: 1, max: 250, editableByClient: true }, pricing: { dependsOn: 'formule', byChoice: { essentiel: 4500, pro: 6000 } }, priceStatus: 'VALIDATED', priceSource: 'Offre 2025' },
          { key: 'serveur', label: 'Serveur', kind: 'OPTIONAL', unit: 'serveur / mois', recurrence: 'MONTHLY', group: 'OPTIONS', quantity: { default: 1, min: 1, max: 10, editableByClient: true }, pricing: { unitPriceCents: 9900 }, priceStatus: 'TO_VALIDATE' },
          { key: 'mise-en-service', label: 'Mise en service', kind: 'SETUP', unit: 'forfait', recurrence: 'ONE_TIME', group: 'SETUP', quantity: { default: 1, min: 1, max: 1, editableByClient: false }, pricing: { unitPriceCents: 50000 }, priceStatus: 'VALIDATED' },
        ],
        rules: [{ type: 'DISCOUNT_PERCENT', key: 'remise-36', percent: 5, appliesTo: ['poste'], when: 'engagement=36', label: 'Remise engagement 36 mois', priceStatus: 'VALIDATED' }],
      },
    },
    versions: [{ id: 'v-1', versionNumber: 1, lockedAt: null, supersededAt: null, changeSummary: null, createdAt: '2026-09-20T08:00:00Z' }],
    recipients: [
      { id: 'r-1', contactId: 'k-1', fullName: 'Alice Martin', email: 'alice@acme.fr', jobTitle: 'DG', role: 'SIGNER', signingOrder: 0 },
      { id: 'r-2', contactId: null, fullName: 'Bob Durand', email: 'bob@acme.fr', jobTitle: null, role: 'READER', signingOrder: 1 },
    ],
    selection: { choices: {}, quantities: {}, selectedOptions: ['serveur'] },
    quote: {
      choices: { formule: 'essentiel', engagement: '12' }, quantities: { poste: 12, serveur: 1, 'mise-en-service': 1 }, selectedOptions: ['serveur'], commitmentMonths: 12,
      lines: [
        { key: 'poste', label: 'Poste de travail', group: 'RECURRING', recurrence: 'MONTHLY', unit: 'poste / mois', quantity: 12, unitPriceCents: '4500', totalHtCents: '54000', priceStatus: 'VALIDATED', priceFrom: false },
        { key: 'serveur', label: 'Serveur', group: 'OPTIONS', recurrence: 'MONTHLY', unit: 'serveur / mois', quantity: 1, unitPriceCents: '9900', totalHtCents: '9900', priceStatus: 'TO_VALIDATE', priceFrom: false },
        { key: 'mise-en-service', label: 'Mise en service', group: 'SETUP', recurrence: 'ONE_TIME', unit: 'forfait', quantity: 1, unitPriceCents: '50000', totalHtCents: '50000', priceStatus: 'VALIDATED', priceFrom: false },
      ],
      infoLines: [],
      totals: {
        oneTime: bucket('50000', '10000', '60000'), monthly: bucket('63900', '12780', '76680'), quarterly: bucket('0', '0', '0'),
        yearly: bucket('0', '0', '0'), commitment: bucket('766800', '153360', '920160'),
      },
      errors: [],
      blockingValidations: [{ scope: 'LINE', key: 'serveur', label: 'Serveur' }],
    },
    readiness: {
      issues: [
        { code: 'TO_COMPLETE', message: 'Section « Votre contexte » à compléter.', sectionKey: 'contexte' },
        { code: 'TO_VALIDATE', message: '« Serveur » est à valider (LINE).' },
      ],
      reviewReasons: [],
      counters: { hasRecipients: true, hasSigner: true, unresolvedMergeTags: 1, blockingValidations: 2, pricingErrors: 0, reviewRequired: false },
    },
    allowedEvents: [],
    stats: [],
    signature: null,
    ...rest,
  } as ProposalDetail;
}

export const TRACKING: Tracking = {
  id: 'p-1', firstViewedAt: '2026-09-21T09:00:00Z', lastActivityAt: '2026-09-26T10:00:00Z', sentAt: '2026-09-20T08:00:00Z',
  stats: [
    { sectionKey: '', opens: 4, totalDurationMs: '185000', pdfDownloads: 1, newViewers: 1, lastViewedAt: '2026-09-26T10:00:00Z' },
    { sectionKey: 'investissement', opens: 3, totalDurationMs: '120000', pdfDownloads: 0, newViewers: 0, lastViewedAt: '2026-09-26T10:00:00Z' },
  ],
  events: [
    { id: 'e-3', recipientId: 'r-1', kind: 'PDF_DOWNLOADED', sectionKey: null, durationMs: null, ipTruncated: '203.0.113.0', occurredAt: '2026-09-26T10:00:00Z' },
    { id: 'e-2', recipientId: 'r-1', kind: 'SECTION_VIEWED', sectionKey: 'investissement', durationMs: 120000, ipTruncated: '203.0.113.0', occurredAt: '2026-09-21T09:05:00Z' },
    { id: 'e-1', recipientId: 'r-1', kind: 'OPENED', sectionKey: null, durationMs: null, ipTruncated: '203.0.113.0', occurredAt: '2026-09-21T09:00:00Z' },
    { id: 'e-4', recipientId: 'r-2', kind: 'NEW_VIEWER', sectionKey: null, durationMs: null, ipTruncated: null, occurredAt: '2026-09-22T09:00:00Z' },
  ],
  deliveries: [
    { id: 'd-2', recipientId: 'r-2', kind: 'INITIAL', subject: 'Proposition PROP-2026-0007', error: 'Boîte pleine', sentAt: '2026-09-20T08:00:05Z', recipient: { fullName: 'Bob Durand', email: 'bob@acme.fr' } },
    { id: 'd-1', recipientId: 'r-1', kind: 'INITIAL', subject: 'Proposition PROP-2026-0007', error: null, sentAt: '2026-09-20T08:00:00Z', recipient: { fullName: 'Alice Martin', email: 'alice@acme.fr' } },
  ],
  followUps: [
    { id: 'f-1', kind: 'NO_DECISION', dueAt: '2026-09-27T08:00:00Z', status: 'PLANNED', sentAt: null, skipReason: null },
    { id: 'f-2', kind: 'BEFORE_EXPIRY', dueAt: '2026-10-18T08:00:00Z', status: 'PLANNED', sentAt: null, skipReason: null },
  ],
  lifecycle: [
    { id: 'l-1', fromStatus: null, toStatus: 'DRAFT', event: null, reason: null, actorKind: 'USER', occurredAt: '2026-09-19T08:00:00Z' },
    { id: 'l-2', fromStatus: 'READY', toStatus: 'SENT', event: 'SEND', reason: null, actorKind: 'USER', occurredAt: '2026-09-20T08:00:00Z' },
  ],
};

export function mountWorkspace(opts: { roles?: string[]; detail?: ProposalDetail; routes?: Record<string, unknown>; path?: string } = {}) {
  const d = opts.detail ?? detail();
  const api = routeFetch({
    'GET /v1/auth/me': { userId: 'u-1', fullName: 'Camille Commerciale', roles: opts.roles ?? ['ACCOUNT_MANAGER'] },
    'GET /v1/proposals/p-1': d,
    'GET /v1/proposals/p-1/tracking': TRACKING,
    'GET /v1/proposals/p-1/comments': { items: [] },
    'GET /v1/proposal-admin/library': { items: [] },
    'GET /v1/customers/c-1': { customer: { id: 'c-1', name: 'Acme' }, contacts: [] },
    ...opts.routes,
  });
  renderWithClient(
    <Routes>
      <Route path="/proposals/:id" element={<ProposalWorkspacePage />} />
      <Route path="/contracts/:id" element={<p>Fiche du contrat</p>} />
    </Routes>,
    [opts.path ?? '/proposals/p-1'],
  );
  return api;
}
