import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ContractContentPanel } from '../features/structure/contract-content-panel.js';
import type { Me } from '../lib/queries.js';
import type { Structure } from '../features/structure/structure-api.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

const me = (permissions: string[]): Me => ({
  userId: 'u1', fullName: 'Léa', email: 'lea@lsi.fr', kind: 'INTERNAL', roles: [], customerId: null, permissions,
});

const STRUCTURE: Structure = {
  versionId: 'v1', versionNumber: 2,
  clauses: [
    { id: 'c1', clauseKey: 'OBJET', position: 1, title: 'Objet', category: 'OBJET', bodyHtml: '<p>Objet du contrat</p>', origin: 'TEMPLATE', sourceClauseVersionId: 'lv1', ai: null },
    { id: 'c2', clauseKey: 'AI-1', position: 2, title: 'Responsabilité', category: 'RESPONSABILITE', bodyHtml: '<p>Plafond 12 mois</p>', origin: 'AI', sourceClauseVersionId: null,
      ai: { risk: 'MEDIUM', justification: 'Art. 1231-3 du Code civil', sources: [{ url: 'https://www.legifrance.gouv.fr/x', title: 'Légifrance' }], review: null } },
  ],
  annexes: [],
  variables: { values: {}, missing: 0, definitions: {} },
  diff: null,
  unreviewedAiClauses: 1,
};
const AVAILABLE = { enabled: true, provider: 'perplexity', configured: true, budgetUsd: 50, spentUsd: 3, available: true };

const props = { contractId: 'k1', currentVersionId: 'v1', imported: false, allowedActions: ['EDIT_CONTENT', 'CANCEL'] };

test('clause IA : bandeau bloquant, badges, justification, sources et validation par le juriste', async () => {
  const api = routeFetch({
    'GET /v1/contracts/k1/structure': STRUCTURE,
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/clauses/c2/review': { clauseId: 'c2', decision: 'APPROVED', unreviewedAiClauses: 0 },
  });
  wrap(<ContractContentPanel {...props} me={me(['clauses.validateAi', 'contracts.aiDraft'])} />);
  expect(await screen.findByText(/Projet généré par IA — à faire valider par un juriste/)).toBeInTheDocument();
  expect(screen.getByText(/1 clause générée par IA reste à valider/)).toBeInTheDocument();
  expect(screen.getByText('Générée par IA')).toBeInTheDocument();
  expect(screen.getByText('Risque moyen')).toBeInTheDocument();
  expect(screen.getByText('Art. 1231-3 du Code civil')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Légifrance' })).toHaveAttribute('href', 'https://www.legifrance.gouv.fr/x');
  // pas de validation sur une clause non IA
  expect(screen.queryByRole('button', { name: 'Valider la clause Objet' })).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(/Commentaire de revue — Responsabilité/), 'Conforme');
  await userEvent.click(screen.getByRole('button', { name: 'Valider la clause Responsabilité' }));
  await waitFor(() => expect(api.find('POST', '/v1/contracts/k1/clauses/c2/review')).toHaveLength(1));
  expect(api.find('POST', '/v1/contracts/k1/clauses/c2/review')[0]!.body).toEqual({ decision: 'APPROVED', comment: 'Conforme' });
});

test('sans clauses.validateAi : pas de boutons de revue ; commercial : lien de modification', async () => {
  routeFetch({ 'GET /v1/contracts/k1/structure': STRUCTURE, 'GET /v1/ai/availability': AVAILABLE });
  wrap(<ContractContentPanel {...props} me={me(['contracts.write', 'contracts.aiDraft'])} />);
  await screen.findByText('Article 2 — Responsabilité');
  expect(screen.queryByRole('button', { name: /Valider la clause/ })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Modifier le contenu' })).toHaveAttribute('href', '/contracts/k1/structure');
});

test('IA désactivée : boutons désactivés et raison expliquée', async () => {
  routeFetch({ 'GET /v1/contracts/k1/structure': STRUCTURE, 'GET /v1/ai/availability': { ...AVAILABLE, enabled: false, available: false } });
  wrap(<ContractContentPanel {...props} me={me(['contracts.write', 'contracts.aiDraft'])} />);
  expect(await screen.findByText('L’assistance IA est désactivée pour votre organisation.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Rédiger avec l’IA' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Durcir la clause Objet' })).toBeDisabled();
});

test('budget atteint : raison affichée', async () => {
  routeFetch({ 'GET /v1/contracts/k1/structure': STRUCTURE, 'GET /v1/ai/availability': { ...AVAILABLE, spentUsd: 50, available: false } });
  wrap(<ContractContentPanel {...props} me={me(['contracts.aiDraft'])} />);
  expect(await screen.findByText(/Budget IA du mois atteint \(50.00 \/ 50 USD\)/)).toBeInTheDocument();
});

test('« Durcir » affiche la suggestion ; « Remplacer la clause » enregistre une nouvelle version (origine IA)', async () => {
  const api = routeFetch({
    'GET /v1/contracts/k1/structure': STRUCTURE,
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/clauses/OBJET/ai': {
      action: 'harden', provider: 'perplexity', sources: [], warnings: [], changes: ['Plafond ajouté'],
      suggestion: { title: 'Objet (durci)', bodyHtml: '<p>Objet strict</p>', riskLevel: 'LOW', justification: 'Plus protecteur' },
    },
    'PUT /v1/contracts/k1/structure': { id: 'k1', status: 'DRAFT', versionId: 'v2', versionNumber: 3, missingVariables: 0, unreviewedAiClauses: 2 },
  });
  wrap(<ContractContentPanel {...props} me={me(['contracts.write', 'contracts.aiDraft'])} />);
  expect(await screen.findByText(/Ce texte pseudonymisé est\s+transmis au fournisseur IA/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Durcir la clause Objet' }));
  const dialog = await screen.findByRole('dialog', { name: /Version durcie proposée — Objet/ });
  expect(await within(dialog).findByText('Objet strict')).toBeInTheDocument();
  expect(within(dialog).getByText('Plafond ajouté')).toBeInTheDocument();
  expect(within(dialog).getAllByText(/pseudonymisé/).length).toBeGreaterThan(0);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remplacer la clause' }));
  await waitFor(() => expect(api.find('PUT', '/v1/contracts/k1/structure')).toHaveLength(1));
  const body = api.find('PUT', '/v1/contracts/k1/structure')[0]!.body as { clauses: unknown[]; changeSummary: string };
  expect(body.clauses[0]).toEqual({ clauseKey: 'OBJET', title: 'Objet (durci)', category: 'OBJET', bodyHtml: '<p>Objet strict</p>', origin: 'AI', sourceClauseVersionId: null, ai: expect.objectContaining({ risk: expect.any(String) }) });
  expect(body.clauses[1]).toMatchObject({ clauseKey: 'AI-1', origin: 'AI' });
  expect(body.changeSummary).toMatch(/suggestion IA/);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('« Expliquer » affiche l’explication ; erreur serveur en français', async () => {
  routeFetch({
    'GET /v1/contracts/k1/structure': STRUCTURE,
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/clauses/OBJET/ai': (b: unknown) => ((b as { action: string }).action === 'explain'
      ? { action: 'explain', provider: 'perplexity', sources: [], warnings: [], explanation: { summary: 'En clair : le contrat couvre…', keyPoints: ['Point A'], pointsOfAttention: ['Attention B'] } }
      : [429, { code: 'AI_BUDGET_EXCEEDED', detail: 'Budget IA du mois atteint (50.00 / 50 USD).' }]),
  });
  wrap(<ContractContentPanel {...props} me={me(['contracts.aiDraft'])} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Expliquer la clause Objet' }));
  expect(await screen.findByText('En clair : le contrat couvre…')).toBeInTheDocument();
  expect(screen.getByText('Attention B')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));
  await userEvent.click(screen.getByRole('button', { name: 'Comparer la clause Objet' }));
  expect(await screen.findByText('Budget IA du mois atteint (50.00 / 50 USD).')).toBeInTheDocument();
});

test('« Rédiger avec l’IA » : mention de pseudonymisation, contrôle du besoin, envoi structuré', async () => {
  const api = routeFetch({
    'GET /v1/contracts/k1/structure': STRUCTURE,
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/ai/draft': { id: 'k1', status: 'DRAFT', versionId: 'v3', versionNumber: 3, unreviewedAiClauses: 5, missingVariables: 0, provider: 'perplexity', sources: [], warnings: [], suggestedAnnexes: [{ title: 'SLA', description: 'Niveaux de service' }] },
  });
  wrap(<ContractContentPanel {...props} me={me(['contracts.write', 'contracts.aiDraft'])} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Rédiger avec l’IA' }));
  const dialog = screen.getByRole('dialog', { name: 'Rédiger avec l’IA' });
  expect(within(dialog).getByText(/Perplexity/)).toBeInTheDocument();
  await userEvent.type(within(dialog).getByLabelText('Besoin du client'), 'court');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Lancer la rédaction' }));
  expect(within(dialog).getByText('Décrivez le besoin (10 caractères au moins).')).toBeInTheDocument();
  await userEvent.type(within(dialog).getByLabelText('Besoin du client'), ' — infogérance de 40 postes');
  await userEvent.type(within(dialog).getByLabelText(/Services/), 'Supervision{enter}Sauvegarde');
  await userEvent.click(within(dialog).getByLabelText(/Remplacer toutes les clauses/));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Lancer la rédaction' }));
  expect(await within(dialog).findByText(/5 clause\(s\) générée\(s\) par IA à faire valider/)).toBeInTheDocument();
  expect(api.find('POST', '/v1/contracts/k1/ai/draft')[0]!.body).toEqual({
    needs: 'court — infogérance de 40 postes', services: ['Supervision', 'Sauvegarde'], mode: 'replace',
  });
});

test('détection des clauses manquantes', async () => {
  routeFetch({
    'GET /v1/contracts/k1/structure': STRUCTURE,
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/ai/missing-clauses': { provider: 'perplexity', sources: [], warnings: [], missing: [{ title: 'Réversibilité', category: 'REVERSIBILITE', reason: 'Sortie du contrat non organisée', riskLevel: 'HIGH' }] },
  });
  wrap(<ContractContentPanel {...props} me={me(['contracts.aiDraft'])} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Détecter les clauses manquantes' }));
  const list = await screen.findByRole('region', { name: 'Clauses manquantes' });
  expect(within(list).getAllByText('Réversibilité')).toHaveLength(2);
  expect(within(list).getByText('Sortie du contrat non organisée')).toBeInTheDocument();
  expect(within(list).getByText('Risque élevé')).toBeInTheDocument();
});
