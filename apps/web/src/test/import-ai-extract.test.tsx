import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportAiExtract } from '../features/ai/import-ai-extract.js';
import { routeFetch } from './fetch-router.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const AVAILABLE = { enabled: true, provider: 'claude', configured: true, budgetUsd: null, spentUsd: 0, available: true };

test('« Compléter avec l’IA » liste les champs ajoutés : méthode LLM, confiance, extrait', async () => {
  const api = routeFetch({
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/import/ai-extract': {
      provider: 'claude', warnings: [], added: ['preavis', 'montantMensuelHtCentimes'],
      extraction: {
        dateEffet: { value: '2026-01-01', confidence: 0.92, evidence: { excerpt: 'prend effet', offset: 1 }, method: 'RULES' },
        preavis: { value: { quantite: 3, unite: 'MOIS' }, confidence: 0.6, evidence: { excerpt: 'préavis de trois mois', offset: 9 }, method: 'LLM' },
        montantMensuelHtCentimes: { value: 150000, confidence: 0.6, evidence: { excerpt: '1 500 € HT par mois', offset: 20 }, method: 'LLM' },
      },
    },
  });
  wrap(<ImportAiExtract contractId="k1" ocrReady />);
  expect(await screen.findByText(/Claude \(Anthropic\)/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Compléter avec l’IA' }));
  expect(await screen.findByText(/2 champ\(s\) complété\(s\) par l’IA/)).toBeInTheDocument();
  expect(screen.getByText('Préavis')).toBeInTheDocument();
  expect(screen.getByText(/3 mois/)).toBeInTheDocument();
  expect(screen.getAllByText('IA (LLM)')).toHaveLength(2);
  expect(screen.getAllByText('Confiance 60 %')).toHaveLength(2);
  expect(screen.getByText(/préavis de trois mois/)).toBeInTheDocument();
  expect(screen.queryByText('Date d’effet')).not.toBeInTheDocument();
  expect(api.find('POST', '/v1/contracts/k1/import/ai-extract')).toHaveLength(1);
});

test('OCR non terminé : bouton désactivé ; erreur OCR_PENDING affichée', async () => {
  routeFetch({ 'GET /v1/ai/availability': AVAILABLE });
  const { unmount } = wrap(<ImportAiExtract contractId="k1" ocrReady={false} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Compléter avec l’IA' })).toBeDisabled());
  expect(screen.getByText(/OCR terminé/)).toBeInTheDocument();
  unmount();
  routeFetch({
    'GET /v1/ai/availability': AVAILABLE,
    'POST /v1/contracts/k1/import/ai-extract': [409, { code: 'OCR_PENDING', detail: "Le texte du document n'est pas encore disponible (OCR en cours ou en échec)." }],
  });
  wrap(<ImportAiExtract contractId="k1" ocrReady />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Compléter avec l’IA' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Compléter avec l’IA' }));
  expect(await screen.findByText(/pas encore disponible/)).toBeInTheDocument();
});

test('IA non configurée : raison expliquée, bouton désactivé', async () => {
  routeFetch({ 'GET /v1/ai/availability': { ...AVAILABLE, configured: false, available: false } });
  wrap(<ImportAiExtract contractId="k1" ocrReady />);
  expect(await screen.findByText(/Aucun accès au fournisseur IA/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Compléter avec l’IA' })).toBeDisabled();
});
