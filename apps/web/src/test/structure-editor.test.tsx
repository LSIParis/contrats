import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructureEditor } from '../features/structure/structure-editor.js';
import { extractVariables, variableRows } from '../features/structure/variables.js';
import { ApiError } from '../lib/api.js';
import type { Structure } from '../features/structure/structure-api.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const STRUCTURE: Structure = {
  versionId: 'v1',
  versionNumber: 3,
  clauses: [
    { id: 'c1', clauseKey: 'OBJET', position: 1, title: 'Objet', category: 'OBJET', bodyHtml: '<p>Entre {{client.raisonSociale}} et nous.</p>', origin: 'TEMPLATE', sourceClauseVersionId: 'lv1', ai: null },
    { id: 'c2', clauseKey: 'AI-X', position: 2, title: 'Responsabilité', category: 'RESPONSABILITE', bodyHtml: '<p>Durée {{contrat.dureeMois}} mois.</p>', origin: 'AI', sourceClauseVersionId: null,
      ai: { risk: 'HIGH', justification: 'Art. 1231-3 C. civ.', sources: [], review: null } },
  ],
  annexes: [{ id: 'a1', position: 1, kind: 'PRICING_GRID', title: 'Grille tarifaire', bodyHtml: null, data: null }],
  variables: {
    values: { 'client.raisonSociale': 'ACME' },
    missing: 1,
    definitions: {
      'client.raisonSociale': { label: 'Raison sociale du client', type: 'string' },
      'contrat.dureeMois': { label: 'Durée initiale (mois)', type: 'integer' },
    },
  },
  diff: { added: [{ key: 'AI-X', title: 'Responsabilité' }], removed: [], modified: [], hasDeviation: true, requiredRemoved: false },
};

test('extractVariables et variableRows repèrent les manquantes et les inconnues', () => {
  expect(extractVariables('<p>{{ a.b }} et {{c.d}} et {{a.b}}</p>')).toEqual(['a.b', 'c.d']);
  const rows = variableRows(['client.raisonSociale', 'contrat.dureeMois', 'x.y'], { 'client.raisonSociale': 'ACME' }, STRUCTURE.variables.definitions);
  expect(rows.map((r) => [r.name, r.missing, r.unknown])).toEqual([
    ['client.raisonSociale', false, false],
    ['contrat.dureeMois', true, false],
    ['x.y', true, true],
  ]);
});

test('affiche clauses, badges IA, annexe à générer, variable manquante surlignée et écarts', () => {
  wrap(<StructureEditor structure={STRUCTURE} status="DRAFT" saving={false} error={null} onSave={() => undefined} />);
  expect(screen.getByText('Article 1 — Objet')).toBeInTheDocument();
  expect(screen.getByText('Article 2 — Responsabilité')).toBeInTheDocument();
  expect(screen.getAllByText('Générée par IA').length).toBeGreaterThan(0);
  expect(screen.getByText('Risque élevé')).toBeInTheDocument();
  expect(screen.getByText('À générer')).toBeInTheDocument();
  expect(screen.getByText('À compléter')).toBeInTheDocument();
  expect(screen.getByText(/1 variable\(s\) à compléter/)).toBeInTheDocument();
  expect(screen.getByText(/Clauses ajoutées \(1\)/)).toBeInTheDocument();
});

test('réordonne, supprime, ajoute une clause libre et enregistre seulement les variables modifiées', async () => {
  const onSave = vi.fn();
  wrap(<StructureEditor structure={STRUCTURE} status="DRAFT" saving={false} error={null} onSave={onSave} />);
  await userEvent.click(screen.getByRole('button', { name: 'Descendre Objet' }));
  expect(screen.getByText('Article 1 — Responsabilité')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Ajouter une clause libre' }));
  expect(screen.getByText('Article 3 — Nouvelle clause')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Supprimer Nouvelle clause' }));
  await userEvent.type(screen.getByLabelText('Durée initiale (mois)'), '24');
  await userEvent.type(screen.getByLabelText(/Résumé de la modification/), 'Ordre revu');
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer \(nouvelle version\)/ }));
  expect(onSave).toHaveBeenCalledTimes(1);
  const payload = onSave.mock.calls[0]![0];
  expect(payload.clauses.map((c: { clauseKey: string }) => c.clauseKey)).toEqual(['AI-X', 'OBJET']);
  expect(payload.clauses[0]).toMatchObject({ origin: 'AI', title: 'Responsabilité' });
  expect(payload.clauses[0]).not.toHaveProperty('ai');
  expect(payload.variables).toEqual({ 'contrat.dureeMois': '24' });
  expect(payload.annexes).toEqual([{ kind: 'PRICING_GRID', title: 'Grille tarifaire', bodyHtml: null, data: null }]);
  expect(payload.changeSummary).toBe('Ordre revu');
});

test('modifie le titre d’une clause dans son panneau', async () => {
  const onSave = vi.fn();
  wrap(<StructureEditor structure={STRUCTURE} status="DRAFT" saving={false} error={null} onSave={onSave} />);
  await userEvent.click(screen.getByRole('button', { name: 'Modifier Objet' }));
  const title = screen.getByLabelText('Titre de la clause');
  await userEvent.clear(title);
  await userEvent.type(title, 'Objet du contrat');
  expect(screen.getByRole('textbox', { name: /Texte de la clause/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer \(nouvelle version\)/ }));
  expect(onSave.mock.calls[0]![0].clauses[0].title).toBe('Objet du contrat');
});

test('ajoute une clause de la bibliothèque (version épinglée)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 'i1', code: 'CONF', category: 'CONFIDENTIALITE', title: 'Confidentialité', isDemo: true,
      currentVersion: { id: 'cv9', versionNumber: 2, bodyHtml: '<p>Secret</p>', variables: [], changeNote: null, createdAt: '2026-01-01' } },
    { id: 'i2', code: 'OBJET', category: 'OBJET', title: 'Objet', isDemo: false,
      currentVersion: { id: 'cv1', versionNumber: 1, bodyHtml: '<p>Objet</p>', variables: [], changeNote: null, createdAt: '2026-01-01' } },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  const onSave = vi.fn();
  wrap(<StructureEditor structure={STRUCTURE} status="DRAFT" saving={false} error={null} onSave={onSave} />);
  await userEvent.click(screen.getByRole('button', { name: 'Ajouter depuis la bibliothèque' }));
  const dialog = await screen.findByRole('dialog', { name: /bibliothèque/ });
  // déjà présente dans le contrat : non ajoutable deux fois
  expect(within(dialog).getByRole('button', { name: 'Ajouter la clause Objet' })).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Rechercher'), 'secret');
  expect(within(dialog).queryByRole('button', { name: 'Ajouter la clause Objet' })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Ajouter la clause Confidentialité' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer \(nouvelle version\)/ }));
  expect(onSave.mock.calls[0]![0].clauses[2]).toEqual({
    clauseKey: 'CONF', title: 'Confidentialité', category: 'CONFIDENTIALITE', bodyHtml: '<p>Secret</p>', origin: 'LIBRARY', sourceClauseVersionId: 'cv9',
  });
});

test('affiche le détail serveur des variables invalides', () => {
  const error = new ApiError(409, 'Variables invalides ou inconnues du registre.', 'VARIABLES_INVALID', {
    invalid: [{ name: 'client.siren', message: 'SIREN : 9 chiffres' }], unknown: ['client.raisonsociale'],
  });
  wrap(<StructureEditor structure={STRUCTURE} status="APPROVED" saving={false} error={error} onSave={() => undefined} />);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Variables invalides ou inconnues du registre.');
  expect(alert).toHaveTextContent('client.siren : SIREN : 9 chiffres');
  expect(alert).toHaveTextContent('client.raisonsociale : variable inconnue du registre');
  expect(screen.getByText(/repassera en brouillon/)).toBeInTheDocument();
});
