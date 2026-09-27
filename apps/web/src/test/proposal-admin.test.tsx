import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import {
  ContentLibraryPage, ContractTemplateSlugsPage, ProposalTemplateDetailPage, ProposalTemplatesPage, TermsPage,
} from '../features/proposals/admin/proposal-admin-pages.js';
import { renderWithClient } from './api-mock.js';
import { routeFetch } from './fetch-router.js';

afterEach(() => vi.unstubAllGlobals());

const TEMPLATES = {
  items: [
    { id: 't-1', slug: 'infogerance', name: 'Infogérance TPE-PME', description: 'Offre socle', acceptanceMode: 'DOCUSEAL_SIGNATURE', contractTemplateSlug: 'infogerance', signedProposalIsContract: false, seedVersion: 3, userModifiedAt: null, archivedAt: null, pendingValidations: 1 },
    { id: 't-2', slug: 'supervision', name: 'Supervision et sauvegarde', description: null, acceptanceMode: 'DOCUSEAL_SIGNATURE', contractTemplateSlug: 'supervision', signedProposalIsContract: false, seedVersion: 2, userModifiedAt: '2026-09-01T00:00:00Z', archivedAt: null, pendingValidations: 10 },
    { id: 't-3', slug: 'rssi', name: 'RSSI externalisé', description: null, acceptanceMode: 'DOCUSEAL_SIGNATURE', contractTemplateSlug: 'rssi-externalise', signedProposalIsContract: false, seedVersion: 1, userModifiedAt: null, archivedAt: null, pendingValidations: 5 },
    { id: 't-4', slug: 'sauvegarde-en-ligne', name: 'Sauvegarde en ligne', description: null, acceptanceMode: 'CLICK_ACCEPT', contractTemplateSlug: 'sauvegarde-en-ligne', signedProposalIsContract: false, seedVersion: 1, userModifiedAt: null, archivedAt: null, pendingValidations: 16 },
  ],
};

const TEMPLATE = {
  ...TEMPLATES.items[0], target: 'TPE-PME', validityDays: 30, providerCountersign: true,
  sections: [
    { key: 'couverture', title: 'Couverture', kind: 'COVER', optional: false, validationStatus: 'VALIDATED', libraryItemKey: null, position: 0 },
    { key: 'niveaux-de-service', title: 'Niveaux de service', kind: 'TEXT', optional: false, validationStatus: 'TO_VALIDATE', libraryItemKey: null, position: 1 },
  ],
  definition: {
    vatRatePercent: 20,
    choices: [{ key: 'formule', label: 'Formule', editableByClient: true, options: [{ value: 'essentiel', label: 'Essentiel', default: true }, { value: 'pro', label: 'Pro' }] }],
    lines: [
      { key: 'poste', label: 'Poste de travail', kind: 'REQUIRED', unit: 'poste / mois', recurrence: 'MONTHLY', group: 'RECURRING', quantity: { default: 1, min: 1, editableByClient: true }, pricing: { dependsOn: 'formule', byChoice: { essentiel: 4500, pro: 6000 } }, priceStatus: 'VALIDATED', priceSource: 'Offre 2025' },
      { key: 'serveur', label: 'Serveur', kind: 'OPTIONAL', unit: 'serveur / mois', recurrence: 'MONTHLY', group: 'OPTIONS', quantity: { default: 1, min: 1, editableByClient: true }, pricing: { unitPriceCents: 9900 }, priceStatus: 'TO_VALIDATE' },
    ],
    rules: [],
  },
  pendingValidations: [{ scope: 'SECTION', key: 'niveaux-de-service', label: 'Niveaux de service' }],
  lines: [],
};

function mount(path: string, roles = ['MSP_ADMIN'], extra: Record<string, unknown> = {}) {
  const api = routeFetch({
    'GET /v1/auth/me': { userId: 'u', fullName: 'Admin', roles },
    'GET /v1/proposal-admin/templates': TEMPLATES,
    'GET /v1/proposal-admin/templates/infogerance': TEMPLATE,
    ...extra,
  });
  renderWithClient(
    <Routes>
      <Route path="/proposal-admin/templates" element={<ProposalTemplatesPage />} />
      <Route path="/proposal-admin/templates/:slug" element={<ProposalTemplateDetailPage />} />
      <Route path="/proposal-admin/library" element={<ContentLibraryPage />} />
      <Route path="/proposal-admin/terms" element={<TermsPage />} />
      <Route path="/proposal-admin/contract-templates" element={<ContractTemplateSlugsPage />} />
    </Routes>,
    [path],
  );
  return api;
}

test('modèles : liste, contrat type associé, éléments à valider, sous-navigation', async () => {
  mount('/proposal-admin/templates');
  const table = await screen.findByRole('table', { name: 'Modèles de proposition' });
  const row = within(table).getByRole('row', { name: /Supervision et sauvegarde/ });
  expect(within(row).getByText('10 à valider')).toBeInTheDocument();
  expect(within(row).getByText('Modifié dans l’interface')).toBeInTheDocument();
  expect(within(row).getAllByText('supervision')).toHaveLength(2);
  expect(within(table).getByRole('link', { name: 'Infogérance TPE-PME' })).toHaveAttribute('href', '/proposal-admin/templates/infogerance');
  const nav = screen.getByRole('navigation', { name: 'Administration des propositions' });
  expect(within(nav).getByRole('link', { name: 'Contrats types' })).toHaveAttribute('href', '/proposal-admin/contract-templates');
});

test('modèle : prix modifié (repasse « à valider ») et option « la proposition signée vaut contrat »', async () => {
  const user = userEvent.setup();
  const api = mount('/proposal-admin/templates/infogerance', ['MSP_ADMIN'], {
    'PATCH /v1/proposal-admin/templates/infogerance/lines/poste': TEMPLATE,
    'PATCH /v1/proposal-admin/templates/infogerance': TEMPLATE,
  });
  const lines = await screen.findByRole('table', { name: 'Lignes de prix du modèle' });
  expect(within(within(lines).getByRole('row', { name: /Serveur/ })).getByText('À valider')).toBeInTheDocument();
  await user.click(within(lines).getByRole('button', { name: 'Modifier le prix de Poste de travail' }));
  const dialog = await screen.findByRole('dialog', { name: 'Prix de « Poste de travail »' });
  expect(within(dialog).getByText(/repasse « à valider »/)).toBeInTheDocument();
  const pro = within(dialog).getByLabelText('Prix HT (€) — Pro');
  await user.clear(pro);
  await user.type(pro, '62,50');
  await user.click(within(dialog).getByRole('button', { name: 'Enregistrer le prix' }));
  await waitFor(() => expect(api.find('PATCH', '/v1/proposal-admin/templates/infogerance/lines/poste')[0]?.body).toEqual({
    pricing: { dependsOn: 'formule', byChoice: { essentiel: 4500, pro: 6250 } },
  }));
  const meta = screen.getByRole('form', { name: 'Paramètres du modèle' });
  expect(within(meta).getByText(/à faire valider par un juriste/)).toBeInTheDocument();
  await user.click(within(meta).getByRole('checkbox', { name: /La proposition signée vaut contrat/ }));
  await user.click(within(meta).getByRole('button', { name: 'Enregistrer le modèle' }));
  await waitFor(() => expect(api.find('PATCH', '/v1/proposal-admin/templates/infogerance')[0]?.body).toEqual({ signedProposalIsContract: true }));
});

test('bibliothèque : dossiers, versions, relecture juridique, création et nouvelle version', async () => {
  const user = userEvent.setup();
  const item = { id: 'l-1', key: 'presentation', title: 'Qui sommes-nous', folder: 'Présentation', body: 'LSI Maintenance, MSP à Aix.', requiresLegalReview: false, version: 3, seedVersion: 1, userModifiedAt: null, updatedAt: '2026-09-01T00:00:00Z' };
  const legal = { ...item, id: 'l-2', key: 'conditions-infogerance', title: 'Conditions infogérance', folder: 'Conditions', requiresLegalReview: true, version: 1 };
  const api = mount('/proposal-admin/library', ['MSP_ADMIN'], {
    'GET /v1/proposal-admin/library': { items: [item, legal] },
    'POST /v1/proposal-admin/library': { ...item, key: 'faq-sauvegarde' },
    'PATCH /v1/proposal-admin/library/presentation': { ...item, version: 4 },
  });
  const region = await screen.findByRole('region', { name: 'Conditions' });
  expect(within(region).getByText('Relecture juridique requise')).toBeInTheDocument();
  const pres = screen.getByRole('region', { name: 'Présentation' });
  expect(within(pres).getByText('v3')).toBeInTheDocument();
  await user.click(within(pres).getByRole('button', { name: 'Modifier « Qui sommes-nous »' }));
  const edit = await screen.findByRole('dialog', { name: 'Modifier « Qui sommes-nous »' });
  const body = within(edit).getByLabelText('Texte (Markdown)');
  await user.clear(body);
  await user.type(body, 'LSI Maintenance, MSP à Aix-en-Provence et Paris.');
  await user.click(within(edit).getByRole('button', { name: 'Enregistrer une nouvelle version' }));
  await waitFor(() => expect(api.find('PATCH', '/v1/proposal-admin/library/presentation')[0]?.body).toEqual({
    title: 'Qui sommes-nous', folder: 'Présentation', body: 'LSI Maintenance, MSP à Aix-en-Provence et Paris.', requiresLegalReview: false,
  }));
  await user.click(screen.getByRole('button', { name: 'Nouveau contenu' }));
  const create = await screen.findByRole('dialog', { name: 'Nouveau contenu' });
  await user.type(within(create).getByLabelText('Clé'), 'faq-sauvegarde');
  await user.type(within(create).getByLabelText('Titre'), 'FAQ sauvegarde');
  await user.type(within(create).getByLabelText('Dossier'), 'FAQ');
  await user.type(within(create).getByLabelText('Texte (Markdown)'), 'Où sont mes données ? En France.');
  await user.click(within(create).getByRole('checkbox', { name: 'Relecture juridique requise' }));
  await user.click(within(create).getByRole('button', { name: 'Créer le contenu' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposal-admin/library')[0]?.body).toEqual({
    key: 'faq-sauvegarde', title: 'FAQ sauvegarde', folder: 'FAQ', body: 'Où sont mes données ? En France.', requiresLegalReview: true,
  }));
});

test('bibliothèque en lecture seule pour un commercial', async () => {
  mount('/proposal-admin/library', ['ACCOUNT_MANAGER'], { 'GET /v1/proposal-admin/library': { items: [] } });
  await screen.findByRole('heading', { name: 'Bibliothèque de contenus' });
  expect(screen.queryByRole('button', { name: 'Nouveau contenu' })).not.toBeInTheDocument();
});

test('CGV : versions immuables, publication confirmée', async () => {
  const user = userEvent.setup();
  const api = mount('/proposal-admin/terms', ['MSP_ADMIN'], {
    'GET /v1/proposal-admin/terms': { items: [{ id: 'cgv-1', versionNumber: 1, title: 'CGV 2025', sha256: 'e'.repeat(64), createdAt: '2025-01-01T00:00:00Z' }] },
    'POST /v1/proposal-admin/terms': { id: 'cgv-2', versionNumber: 2, title: 'CGV 2026', sha256: 'f'.repeat(64), createdAt: '2026-09-27T00:00:00Z' },
  });
  const table = await screen.findByRole('table', { name: 'Versions des CGV' });
  expect(within(table).getByText('CGV 2025')).toBeInTheDocument();
  await user.type(screen.getByLabelText('Titre de la version'), 'CGV 2026');
  await user.type(screen.getByLabelText('Texte des CGV (Markdown)'), 'Article 1 — Objet. Les présentes conditions…');
  await user.click(screen.getByRole('button', { name: 'Publier une nouvelle version' }));
  const dialog = await screen.findByRole('dialog', { name: 'Publier les CGV ?' });
  expect(within(dialog).getByText(/immuable/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Publier' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposal-admin/terms')[0]?.body).toEqual({ title: 'CGV 2026', body: 'Article 1 — Objet. Les présentes conditions…' }));
});

test('contrats types : les quatre slugs attendus, association et avertissement si non publié', async () => {
  const user = userEvent.setup();
  const api = mount('/proposal-admin/contract-templates', ['MSP_ADMIN'], {
    'GET /v1/templates': {
      items: [
        { id: 'ct-1', name: 'Contrat d’infogérance', category: 'MAINTENANCE', status: 'PUBLISHED', versionCount: 2, slug: 'infogerance' },
        { id: 'ct-2', name: 'Contrat de supervision', category: 'MAINTENANCE', status: 'DRAFT', versionCount: 1 },
      ],
    },
    'PUT /v1/proposal-admin/contract-templates/ct-2/slug': { id: 'ct-2', slug: 'supervision' },
  });
  const required = await screen.findByRole('table', { name: 'Slugs attendus par les modèles de proposition' });
  expect(within(required).getAllByRole('row')).toHaveLength(5);
  expect(within(within(required).getByRole('row', { name: /infogerance/ })).getByText('Contrat d’infogérance')).toBeInTheDocument();
  expect(within(within(required).getByRole('row', { name: /rssi-externalise/ })).getByText('Non associé : la conversion échouera')).toBeInTheDocument();
  const list = screen.getByRole('table', { name: 'Contrats types' });
  const row = within(list).getByRole('row', { name: /Contrat de supervision/ });
  await user.selectOptions(within(row).getByLabelText('Slug de Contrat de supervision'), 'supervision');
  await user.click(within(row).getByRole('button', { name: 'Associer Contrat de supervision' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposal-admin/contract-templates/ct-2/slug')[0]?.body).toEqual({ slug: 'supervision' }));
  expect(await within(within(required).getByRole('row', { name: /^supervision/ })).findByText(/non publié/)).toBeInTheDocument();
});
