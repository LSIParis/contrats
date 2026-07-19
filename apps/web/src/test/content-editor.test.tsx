import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContentEditor } from '../features/contracts/content-editor.js';

test('« Enregistrer » renvoie le HTML initial si non modifié', async () => {
  const onSave = vi.fn();
  render(<ContentEditor initialHtml="<p>Bonjour</p>" saving={false} onSave={onSave} onPreview={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: /Enregistrer/ }));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(String(onSave.mock.calls[0]![0])).toContain('Bonjour');
});

test('bouton Aperçu PDF présent', () => {
  render(<ContentEditor initialHtml="<p>x</p>" saving={false} onSave={() => {}} onPreview={() => {}} />);
  expect(screen.getByRole('button', { name: /Aperçu PDF/ })).toBeInTheDocument();
});
