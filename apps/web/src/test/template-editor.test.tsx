import { render, screen } from '@testing-library/react';
import { TemplateEditor } from '../features/templates/template-editor.js';

test('affiche la barre d\'outils (Gras, Titre, Citation)', () => {
  render(<TemplateEditor initialHtml="<p>x</p>" onChange={() => {}} />);
  expect(screen.getByRole('button', { name: 'G' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Titre' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Citation' })).toBeInTheDocument();
});

test('émet le HTML initial au montage', () => {
  const onChange = vi.fn();
  render(<TemplateEditor initialHtml="<p>Bonjour</p>" onChange={onChange} />);
  expect(onChange).toHaveBeenCalled();
  expect(String(onChange.mock.calls.at(-1)![0])).toContain('Bonjour');
});

test('remonte l\'état « vide » au montage', () => {
  const onEmptyChange = vi.fn();
  render(<TemplateEditor initialHtml="<p>Du contenu</p>" onChange={() => {}} onEmptyChange={onEmptyChange} />);
  expect(onEmptyChange).toHaveBeenLastCalledWith(false);
});

test('injecte un nouveau contenu quand nonce change (brouillon IA)', () => {
  const onChange = vi.fn();
  const { rerender } = render(<TemplateEditor initialHtml="<p>vide</p>" onChange={onChange} />);
  onChange.mockClear();
  rerender(
    <TemplateEditor initialHtml="<p>vide</p>" onChange={onChange} inject={{ html: '<p>Nouveau brouillon IA</p>', nonce: 1 }} />,
  );
  expect(String(onChange.mock.calls.at(-1)![0])).toContain('Nouveau brouillon IA');
});
