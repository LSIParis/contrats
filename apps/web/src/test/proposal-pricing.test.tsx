import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detail, mountWorkspace } from './proposal-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

async function openPricing() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Tarification' }));
  return { user, panel: await screen.findByRole('region', { name: 'Tableau de prix' }) };
}

test('lignes, statut « à valider », totaux HT / TVA / TTC du serveur et lien « Prix à valider »', async () => {
  mountWorkspace();
  const { panel } = await openPricing();
  const table = within(panel).getByRole('table', { name: 'Lignes retenues (montants HT)' });
  const row = within(table).getByRole('row', { name: /Serveur/ });
  expect(within(row).getByText('À valider')).toBeInTheDocument();
  expect(within(row).getAllByText('99,00 €')).toHaveLength(2);
  const totals = within(panel).getByRole('list', { name: 'Totaux' });
  expect(within(totals).getByText('639,00 € HT')).toBeInTheDocument();
  expect(within(totals).getByText('127,80 € TVA')).toBeInTheDocument();
  expect(within(totals).getByText('766,80 € TTC')).toBeInTheDocument();
  expect(within(totals).getByText(/Total sur 12 mois/)).toBeInTheDocument();
  expect(within(totals).getByText('7 668,00 € HT')).toBeInTheDocument();
  const blocking = within(panel).getByRole('region', { name: 'Éléments à valider retenus' });
  expect(within(blocking).getByText(/Serveur/)).toBeInTheDocument();
  expect(within(blocking).getByRole('link', { name: 'Ouvrir « Prix à valider »' })).toHaveAttribute('href', '/proposal-admin/pending');
});

test('configuration : formule, option, quantité bornée → PUT selection (recalcul serveur)', async () => {
  const api = mountWorkspace({ routes: { 'PUT /v1/proposals/p-1/selection': detail() } });
  const { user, panel } = await openPricing();
  const formule = within(panel).getByRole('radiogroup', { name: 'Formule' });
  await user.click(within(formule).getByRole('radio', { name: 'Pro' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/selection')[0]?.body).toEqual({ choices: { formule: 'pro' } }));
  await user.click(within(panel).getByRole('checkbox', { name: 'Serveur' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/selection')[1]?.body).toEqual({ selectedOptions: [] }));
  const qty = within(panel).getByLabelText('Quantité — Poste de travail');
  expect(within(panel).getByText('Bornes : 1 à 250')).toBeInTheDocument();
  await user.clear(qty);
  await user.type(qty, '20');
  await user.tab();
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/selection')[2]?.body).toEqual({ quantities: { poste: 20 } }));
});

test('erreurs de configuration renvoyées par le moteur', async () => {
  const d = detail();
  d.quote.errors = ['Serveur : 12 au plus (parc.nbServeurs).'];
  mountWorkspace({ detail: d });
  const { panel } = await openPricing();
  expect(within(panel).getByRole('alert')).toHaveTextContent('Serveur : 12 au plus');
});

test('prix unitaires, remise et nouvelle ligne → PUT pricing (définition complète, prix modifié « à valider »)', async () => {
  const api = mountWorkspace({ routes: { 'PUT /v1/proposals/p-1/pricing': detail() } });
  const { user, panel } = await openPricing();
  await user.click(within(panel).getByRole('button', { name: 'Modifier les prix' }));
  const price = within(panel).getByLabelText('Prix unitaire HT (€) — Serveur');
  await user.clear(price);
  await user.type(price, '120,50');
  const pro = within(panel).getByLabelText('Prix unitaire HT (€) — Poste de travail (Pro)');
  await user.clear(pro);
  await user.type(pro, '65');
  const discount = within(panel).getByLabelText('Remise (%) — Remise engagement 36 mois');
  await user.clear(discount);
  await user.type(discount, '8');
  await user.click(within(panel).getByRole('button', { name: 'Ajouter une ligne' }));
  await user.type(within(panel).getByLabelText('Libellé de la ligne'), 'Sauvegarde M365');
  await user.type(within(panel).getByLabelText('Unité'), 'utilisateur / mois');
  await user.selectOptions(within(panel).getByLabelText('Type de ligne'), 'OPTIONAL');
  await user.type(within(panel).getByLabelText('Prix unitaire HT (€)'), '3,5');
  await user.clear(within(panel).getByLabelText('Quantité maximale'));
  await user.type(within(panel).getByLabelText('Quantité maximale'), '300');
  await user.click(within(panel).getByRole('button', { name: 'Enregistrer les prix' }));
  await waitFor(() => expect(api.find('PUT', '/v1/proposals/p-1/pricing')).toHaveLength(1));
  const body = api.find('PUT', '/v1/proposals/p-1/pricing')[0]!.body as { lines: Record<string, any>[]; rules: Record<string, any>[]; choices: unknown[]; vatRatePercent: number };
  expect(body.vatRatePercent).toBe(20);
  expect(body.choices).toHaveLength(2);
  expect(body.lines.find((l) => l.key === 'serveur')!.pricing).toEqual({ unitPriceCents: 12050 });
  expect(body.lines.find((l) => l.key === 'poste')!.pricing).toEqual({ dependsOn: 'formule', byChoice: { essentiel: 4500, pro: 6500 } });
  expect(body.rules[0]!.percent).toBe(8);
  expect(body.lines.find((l) => l.key === 'sauvegarde-m365')).toEqual({
    key: 'sauvegarde-m365', label: 'Sauvegarde M365', kind: 'OPTIONAL', unit: 'utilisateur / mois', recurrence: 'MONTHLY', group: 'OPTIONS',
    quantity: { default: 1, min: 1, max: 300, editableByClient: true }, pricing: { unitPriceCents: 350 }, priceStatus: 'TO_VALIDATE', priceSource: 'Saisie commerciale',
  });
});

test('administrateur : valide un prix « à valider » de la proposition', async () => {
  const api = mountWorkspace({ roles: ['MSP_ADMIN'], routes: { 'POST /v1/proposals/p-1/pricing/validate': detail() } });
  const { user, panel } = await openPricing();
  await user.click(within(panel).getByRole('button', { name: 'Valider « Serveur »' }));
  await waitFor(() => expect(api.find('POST', '/v1/proposals/p-1/pricing/validate')[0]?.body).toEqual({ scope: 'LINE', key: 'serveur' }));
});

test('après l’envoi : configuration en lecture seule', async () => {
  mountWorkspace({ detail: detail({ proposal: { status: 'VIEWED' } }) });
  const { panel } = await openPricing();
  expect(within(panel).getByText(/la configuration appartient au client/)).toBeInTheDocument();
  expect(within(panel).queryByRole('radio')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: 'Modifier les prix' })).not.toBeInTheDocument();
});
