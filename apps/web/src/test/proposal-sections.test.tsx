import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detail, mountWorkspace } from './proposal-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const editor = () => screen.findByRole('region', { name: 'Sections de la proposition' });

test('sections dans l’ordre, blocs obligatoires verrouillés, consigne et statut « à valider » affichés', async () => {
  mountWorkspace();
  const ed = await editor();
  const titles = within(ed).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
  expect(titles).toEqual(['Couverture', 'Votre contexte', 'Qui sommes-nous', 'Niveaux de service', 'Votre investissement', 'Conditions générales de vente', 'Acceptation et signature']);
  expect(within(ed).queryByRole('button', { name: 'Supprimer « Votre investissement »' })).not.toBeInTheDocument();
  expect(within(ed).queryByRole('button', { name: 'Supprimer « Acceptation et signature »' })).not.toBeInTheDocument();
  expect(within(ed).getByRole('button', { name: 'Supprimer « Qui sommes-nous »' })).toBeInTheDocument();
  expect(within(ed).getByText(/Décrire le parc et les enjeux/)).toBeInTheDocument();
  expect(within(ed).getByText('Section « Votre contexte » à compléter.')).toBeInTheDocument();
  expect(within(ed).getAllByText('À valider').length).toBeGreaterThan(0);
  expect(within(ed).getByText(/CGV v3 — CGV 2026/)).toBeInTheDocument();
});

test('réordonner, modifier le texte, insérer une balise puis enregistrer : PUT au format strict de l’API', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({ routes: { 'PUT /v1/proposals/p-1/sections': detail() } });
  const ed = await editor();
  await user.click(within(ed).getByRole('button', { name: 'Monter « Qui sommes-nous »' }));
  const text = within(ed).getByLabelText('Texte (Markdown) — Votre contexte');
  await user.type(text, 'Parc de ');
  await user.selectOptions(within(ed).getByLabelText('Balise à insérer — Votre contexte'), 'parc.nbPostes');
  await user.click(within(ed).getByRole('button', { name: 'Insérer la balise — Votre contexte' }));
  expect(text).toHaveValue('Parc de {{parc.nbPostes}}');
  expect(within(ed).getByText('{{parc.nbPostes}}')).toBeInTheDocument();
  await user.click(within(ed).getByRole('button', { name: 'Enregistrer le contenu' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/sections')).toHaveLength(1));
  const body = api.find('PUT', '/v1/proposals/p-1/sections')[0]!.body as { sections: Record<string, unknown>[] };
  expect(body.sections.map((s) => s.key)).toEqual(['couverture', 'qui-sommes-nous', 'contexte', 'niveaux-de-service', 'investissement', 'cgv', 'signature']);
  expect(body.sections[2]).toEqual({
    key: 'contexte', title: 'Votre contexte', kind: 'CLIENT_INPUT', optional: false, excluded: false, libraryItemKey: null,
    guidance: 'Décrire le parc et les enjeux.', blocks: [{ type: 'RICH_TEXT', content: { markdown: 'Parc de {{parc.nbPostes}}' } }],
  });
});

test('section facultative exclue, section supprimée, section de texte ajoutée avec un bloc FAQ', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({ routes: { 'PUT /v1/proposals/p-1/sections': detail() } });
  const ed = await editor();
  await user.click(within(ed).getByRole('checkbox', { name: 'Inclure « Niveaux de service »' }));
  await user.click(within(ed).getByRole('button', { name: 'Supprimer « Qui sommes-nous »' }));
  await user.click(within(ed).getByRole('button', { name: 'Ajouter une section de texte' }));
  const title = within(ed).getByDisplayValue('Nouvelle section');
  await user.clear(title);
  await user.type(title, 'Planning');
  await user.selectOptions(within(ed).getByLabelText('Type de bloc à ajouter — Planning'), 'FAQ');
  await user.click(within(ed).getByRole('button', { name: 'Ajouter le bloc — Planning' }));
  await user.click(within(ed).getByRole('button', { name: 'Ajouter un élément' }));
  await user.type(within(ed).getByLabelText('Question 1'), 'Délai ?');
  await user.type(within(ed).getByLabelText('Réponse 1'), '4 h');
  await user.click(within(ed).getByRole('button', { name: 'Enregistrer le contenu' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/sections')).toHaveLength(1));
  const body = api.find('PUT', '/v1/proposals/p-1/sections')[0]!.body as { sections: { key: string; excluded: boolean; kind: string; title: string; blocks: unknown[] }[] };
  expect(body.sections.find((s) => s.key === 'qui-sommes-nous')).toBeUndefined();
  expect(body.sections.find((s) => s.key === 'niveaux-de-service')!.excluded).toBe(true);
  const added = body.sections.find((s) => s.title === 'Planning')!;
  expect(added.kind).toBe('TEXT');
  expect(added.blocks).toEqual([{ type: 'RICH_TEXT', content: { markdown: '' } }, { type: 'FAQ', content: { items: [{ question: 'Délai ?', answer: '4 h' }] } }]);
  // Insérée avant le tableau de prix.
  expect(body.sections.map((s) => s.kind).indexOf('TEXT')).toBeLessThan(body.sections.map((s) => s.kind).indexOf('PRICING'));
});

test('ajout depuis la bibliothèque : texte copié avec sa clé source', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({
    routes: {
      'PUT /v1/proposals/p-1/sections': detail(),
      'GET /v1/proposal-admin/library': { items: [{ id: 'l-1', key: 'engagements', title: 'Nos engagements', folder: 'Présentation', body: 'Un interlocuteur unique.', requiresLegalReview: true, version: 2, seedVersion: 1, userModifiedAt: null, updatedAt: '2026-09-01T00:00:00Z' }] },
    },
  });
  const ed = await editor();
  await user.click(within(ed).getByRole('button', { name: 'Ajouter depuis la bibliothèque' }));
  const dialog = await screen.findByRole('dialog', { name: 'Bibliothèque de contenus' });
  expect(within(dialog).getByText('Relecture juridique requise')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Insérer « Nos engagements »' }));
  await user.click(within(ed).getByRole('button', { name: 'Enregistrer le contenu' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/sections')).toHaveLength(1));
  const body = api.find('PUT', '/v1/proposals/p-1/sections')[0]!.body as { sections: { key: string; kind: string; libraryItemKey: string; blocks: { content: { markdown: string } }[] }[] };
  const s = body.sections.find((x) => x.key === 'engagements')!;
  expect(s.kind).toBe('LIBRARY');
  expect(s.libraryItemKey).toBe('engagements');
  expect(s.blocks[0]!.content.markdown).toBe('Un interlocuteur unique.');
});

test('erreur de validation du serveur affichée', async () => {
  const user = userEvent.setup();
  mountWorkspace({ routes: { 'PUT /v1/proposals/p-1/sections': [400, { statusCode: 400, message: ['il faut exactement une section PRICING'] }] } });
  const ed = await editor();
  await user.type(within(ed).getByLabelText('Texte (Markdown) — Votre contexte'), 'x');
  await user.click(within(ed).getByRole('button', { name: 'Enregistrer le contenu' }));
  expect(await within(ed).findByRole('alert')).toHaveTextContent('il faut exactement une section PRICING');
});

test('import Word : le fichier part en multipart', async () => {
  const api = mountWorkspace({ routes: { 'POST /v1/proposals/p-1/import-docx': detail() } });
  const ed = await editor();
  const input = within(ed).getByLabelText('Importer un document Word (.docx)');
  const file = new File(['PK'], 'proposition.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/import-docx')).toHaveLength(1));
  const form = api.find('POST', '/v1/proposals/p-1/import-docx')[0]!.body as FormData;
  expect((form.get('file') as File).name).toBe('proposition.docx');
});

test('administrateur : valide une section « à valider » de la proposition', async () => {
  const user = userEvent.setup();
  const api = mountWorkspace({ roles: ['MSP_ADMIN'], routes: { 'POST /v1/proposals/p-1/sections/niveaux-de-service/validate': detail() } });
  const ed = await editor();
  await user.click(within(ed).getByRole('button', { name: 'Valider la section « Niveaux de service »' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/sections/niveaux-de-service/validate')).toHaveLength(1));
});

test('version envoyée : lecture seule', async () => {
  mountWorkspace({ detail: detail({ proposal: { status: 'SENT' }, version: { ...detail().version, lockedAt: '2026-09-20T08:00:00Z' } }) });
  const ed = await editor();
  expect(within(ed).getByText(/Version figée/)).toBeInTheDocument();
  expect(within(ed).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(ed).queryByRole('button', { name: 'Enregistrer le contenu' })).not.toBeInTheDocument();
});
