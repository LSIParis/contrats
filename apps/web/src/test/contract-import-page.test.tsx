import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractImportForm } from '../features/contracts/contract-import-page.js';

test('rend les champs (référence, titre, fichier) et onSubmit reçoit un FormData avec la référence saisie et le fichier joint', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(
    <ContractImportForm
      customers={[{ id: 'c1', name: 'Dupont SAS' }]}
      submitting={false}
      onSubmit={onSubmit}
    />,
  );

  expect(screen.getByLabelText(/Client/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Référence/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Titre/)).toBeInTheDocument();
  const fileInput = screen.getByLabelText(/Document/i);
  expect(fileInput).toHaveAttribute('type', 'file');

  await user.selectOptions(screen.getByLabelText(/Client/), 'c1');
  await user.type(screen.getByLabelText(/Référence/), 'LSI-2026-001');
  await user.type(screen.getByLabelText(/Titre/), 'Contrat historique');

  const file = new File(['contenu'], 'contrat.pdf', { type: 'application/pdf' });
  await user.upload(fileInput, file);

  await user.click(screen.getByRole('button', { name: /Importer/ }));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  const fd = onSubmit.mock.calls[0]![0] as FormData;
  expect(fd.get('reference')).toBe('LSI-2026-001');
  expect(fd.get('customerId')).toBe('c1');
  const submittedFile = fd.get('document') as File;
  expect(submittedFile).toBeInstanceOf(File);
  expect(submittedFile.name).toBe('contrat.pdf');
});

test('le bouton est désactivé tant que le formulaire est incomplet', () => {
  render(<ContractImportForm customers={[{ id: 'c1', name: 'Dupont SAS' }]} submitting={false} onSubmit={vi.fn()} />);
  expect(screen.getByRole('button', { name: /Importer/ })).toBeDisabled();
});

test('affiche le message d’erreur fourni (ex. référence en double)', () => {
  render(
    <ContractImportForm customers={[]} submitting={false} error="Référence déjà utilisée." onSubmit={vi.fn()} />,
  );
  expect(screen.getByText('Référence déjà utilisée.')).toBeInTheDocument();
});
