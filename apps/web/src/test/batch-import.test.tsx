import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BatchImportForm, BatchResults, ContractImportForm, ContractImportPage } from '../features/contracts/contract-import-page.js';

const customers = [{ id: 'c1', name: 'Dupont SAS' }];
const pdf = (name: string) => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

afterEach(() => vi.unstubAllGlobals());

test('import unitaire : client + document suffisent, les champs vides ne sont pas envoyés', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<ContractImportForm customers={customers} submitting={false} onSubmit={onSubmit} />);
  await user.selectOptions(screen.getByLabelText(/Client/), 'c1');
  await user.upload(screen.getByLabelText(/Document/), pdf('a.pdf'));
  await user.click(screen.getByRole('button', { name: /Importer le contrat/ }));
  const fd = onSubmit.mock.calls[0]![0] as FormData;
  expect(fd.get('customerId')).toBe('c1');
  expect(fd.has('reference')).toBe(false);
  expect(fd.has('title')).toBe(false);
  expect(fd.has('category')).toBe(false);
  expect((fd.get('document') as File).name).toBe('a.pdf');
});

test('import par lot : un seul client, plusieurs fichiers sous le champ « documents »', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<BatchImportForm customers={customers} submitting={false} onSubmit={onSubmit} />);
  const button = screen.getByRole('button', { name: /Importer le lot/ });
  expect(button).toBeDisabled();
  await user.selectOptions(screen.getByLabelText(/Client/), 'c1');
  await user.upload(screen.getByLabelText(/Documents/), [pdf('a.pdf'), pdf('b.pdf')]);
  expect(screen.getByText('2 fichier(s) sélectionné(s).')).toBeInTheDocument();
  await user.click(button);
  const fd = onSubmit.mock.calls[0]![0] as FormData;
  expect(fd.get('customerId')).toBe('c1');
  expect((fd.getAll('documents') as File[]).map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
});

test('résultat par fichier : importé (lien de validation) ou refusé (motif), focus sur le bilan', () => {
  render(
    <MemoryRouter>
      <BatchResults items={[
        { filename: 'a.pdf', id: 'k1' },
        { filename: 'faux.pdf', error: 'Format non supporté ou contenu incohérent (PDF ou DOCX attendu).' },
      ]} />
    </MemoryRouter>,
  );
  const heading = screen.getByRole('heading', { name: /1 importé\(s\), 1 refusé\(s\)/ });
  expect(heading).toHaveFocus();
  expect(screen.getByText('Importé')).toBeInTheDocument();
  expect(screen.getByText('Refusé')).toBeInTheDocument();
  expect(screen.getByText(/Format non supporté/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Valider l’import de a.pdf/ })).toHaveAttribute('href', '/contracts/k1/import');
});

test('page : l’onglet « Import par lot » poste sur /import/batch et affiche le bilan', async () => {
  const user = userEvent.setup();
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body = url.includes('/import/batch')
      ? { items: [{ filename: 'a.pdf', id: 'k1' }, { filename: 'b.pdf', error: 'Refusé par l’API' }] }
      : { items: customers };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ContractImportPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('tab', { name: 'Import par lot' }));
  await user.selectOptions(screen.getByLabelText(/Client/), 'c1');
  await user.upload(screen.getByLabelText(/Documents/), [pdf('a.pdf'), pdf('b.pdf')]);
  await user.click(screen.getByRole('button', { name: /Importer le lot/ }));
  await waitFor(() => expect(screen.getByText('Refusé par l’API')).toBeInTheDocument());
  expect(calls).toContain('POST /v1/contracts/import/batch');
});
