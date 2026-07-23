import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiDraftPanel } from '../features/templates/ai-draft-panel.js';

test('affiche la bannière « à valider par un juriste »', () => {
  render(<AiDraftPanel generating={false} onGenerate={() => {}} />);
  expect(screen.getByText(/valider par un juriste/i)).toBeInTheDocument();
});

test('« Générer » transmet le prompt saisi', async () => {
  const onGenerate = vi.fn();
  render(<AiDraftPanel generating={false} onGenerate={onGenerate} />);
  await userEvent.type(screen.getByPlaceholderText(/décri/i), 'Contrat de maintenance annuel');
  await userEvent.click(screen.getByRole('button', { name: /Générer/ }));
  expect(onGenerate).toHaveBeenCalledTimes(1);
  expect(onGenerate.mock.calls[0]![0].prompt).toContain('maintenance annuel');
});

test('bouton désactivé pendant la génération', () => {
  render(<AiDraftPanel generating={true} onGenerate={() => {}} />);
  expect(screen.getByRole('button', { name: /Génération|Générer/ })).toBeDisabled();
});
