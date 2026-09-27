import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detail, mountWorkspace } from './proposal-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const AVAILABLE = { enabled: true, provider: 'perplexity', configured: true, budgetUsd: 50, spentUsd: 10, available: true };
const editor = () => screen.findByRole('region', { name: 'Sections de la proposition' });

function aiDetail() {
  const d = detail();
  d.version.sections = d.version.sections.map((s) => (s.key === 'contexte'
    ? { ...s, aiPendingReview: true, aiSources: [{ url: 'https://example.org/acme', title: 'Acme — actualités' }], blocks: [{ type: 'RICH_TEXT', content: { markdown: 'Acme compte 40 postes.' } }] }
    : s));
  d.readiness.issues = [{ code: 'AI_PENDING', message: 'Section « Votre contexte » générée par IA : à relire et valider avant envoi.', sectionKey: 'contexte' }];
  return d;
}

test('IA indisponible : bouton désactivé et raison expliquée', async () => {
  mountWorkspace({ routes: { 'GET /v1/ai/availability': { ...AVAILABLE, spentUsd: 50 } } });
  const ed = await editor();
  expect(await within(ed).findByText(/Budget IA du mois atteint/)).toBeInTheDocument();
  expect(within(ed).getByRole('button', { name: 'Rédiger avec l’IA' })).toBeDisabled();
});

test('rédaction IA : notes, sections, recherche publique explicite (décochée par défaut), puis points à vérifier et sources', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({
    routes: {
      'GET /v1/ai/availability': AVAILABLE,
      'POST /v1/proposals/p-1/ai/draft': {
        proposal: aiDetail(), provider: 'perplexity', pointsToVerify: ['Nombre de sites à confirmer.'],
        research: { sector: 'Industrie', size: '50 salariés', summary: 'PME industrielle.', recentNews: [{ title: 'Nouvelle usine', date: '2026-05' }] },
        sources: [{ url: 'https://example.org/acme', title: 'Acme — actualités' }], warnings: [],
      },
    },
  });
  const ed = await editor();
  await user.click(await within(ed).findByRole('button', { name: 'Rédiger avec l’IA' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rédiger avec l’IA' });
  expect(within(dialog).getAllByText(/pseudonymisé/).length).toBeGreaterThan(0);
  const research = within(dialog).getByRole('checkbox', { name: /Recherche publique sur l’entreprise/ });
  expect(research).not.toBeChecked();
  expect(within(dialog).queryByLabelText('Site web de l’entreprise')).not.toBeInTheDocument();
  await user.type(within(dialog).getByLabelText('Prise de notes'), 'Parc de 40 postes, deux sites, sauvegarde absente.');
  await user.click(within(dialog).getByRole('checkbox', { name: 'Enjeux' }));
  await user.click(research);
  await user.type(within(dialog).getByLabelText('Site web de l’entreprise'), 'https://acme.example');
  await user.click(within(dialog).getByRole('button', { name: 'Lancer la rédaction' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/ai/draft')[0]?.body).toEqual({
    notes: 'Parc de 40 postes, deux sites, sauvegarde absente.', sections: ['contexte', 'solution'], publicResearch: true, website: 'https://acme.example',
  }));
  expect(await within(dialog).findByText('Nombre de sites à confirmer.')).toBeInTheDocument();
  expect(within(dialog).getByText(/PME industrielle/)).toBeInTheDocument();
  expect(within(dialog).getByRole('link', { name: 'Acme — actualités' })).toHaveAttribute('href', 'https://example.org/acme');
  await user.click(within(dialog).getByRole('button', { name: 'Fermer la rédaction' }));
  expect(await within(await editor()).findByText('Généré par IA — à relire')).toBeInTheDocument();
});

test('erreur IA (budget) : detail du serveur affiché', async () => {
  const user = userEvent.setup();
  mountWorkspace({
    routes: {
      'GET /v1/ai/availability': AVAILABLE,
      'POST /v1/proposals/p-1/ai/draft': [429, { code: 'AI_BUDGET_EXCEEDED', detail: 'Budget IA mensuel atteint.' }],
    },
  });
  const ed = await editor();
  await user.click(await within(ed).findByRole('button', { name: 'Rédiger avec l’IA' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rédiger avec l’IA' });
  await user.type(within(dialog).getByLabelText('Prise de notes'), 'Des notes suffisamment longues pour partir.');
  await user.click(within(dialog).getByRole('button', { name: 'Lancer la rédaction' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Budget IA mensuel atteint.');
});

test('section générée par IA : bandeau, sources, point bloquant et validation humaine', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({ detail: aiDetail(), routes: { 'GET /v1/ai/availability': AVAILABLE, 'POST /v1/proposals/p-1/sections/contexte/ai-validate': detail() } });
  const ed = await editor();
  const banner = within(ed).getByRole('region', { name: 'Généré par IA — Votre contexte' });
  expect(within(banner).getByRole('link', { name: 'Acme — actualités' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Points bloquants avant envoi' })).toHaveTextContent('générée par IA : à relire');
  await user.click(within(banner).getByRole('button', { name: 'Valider cette section' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/sections/contexte/ai-validate')).toHaveLength(1));
});

test('reformulation : suggestion affichée, appliquée seulement par « Remplacer »', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({
    routes: {
      'GET /v1/ai/availability': AVAILABLE,
      'POST /v1/proposals/p-1/ai/rephrase': { text: 'LSI Maintenance, infogérant à Aix-en-Provence.', changes: ['Style plus direct.'], provider: 'perplexity', warnings: [] },
    },
  });
  const ed = await editor();
  await user.click(await within(ed).findByRole('button', { name: 'Reformuler avec l’IA — Qui sommes-nous' }));
  const panel = within(ed).getByRole('region', { name: 'Suggestion IA — Qui sommes-nous' });
  await user.click(within(panel).getByRole('radio', { name: 'Synthétiser' }));
  await user.click(within(panel).getByRole('button', { name: 'Proposer' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/ai/rephrase')[0]?.body).toEqual({ text: 'LSI Maintenance, MSP à Aix.', mode: 'synthetiser' }));
  expect(await within(panel).findByText('Style plus direct.')).toBeInTheDocument();
  const text = within(ed).getByLabelText('Texte (Markdown) — Qui sommes-nous');
  expect(text).toHaveValue('LSI Maintenance, MSP à Aix.');
  await user.click(within(panel).getByRole('button', { name: 'Remplacer' }));
  expect(text).toHaveValue('LSI Maintenance, infogérant à Aix-en-Provence.');
  expect(within(ed).getByRole('button', { name: 'Enregistrer le contenu' })).toBeEnabled();
});
