import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Tabs } from '../ui/tabs.js';
import { Modal } from '../ui/modal.js';
import { ToastProvider, useToast } from '../ui/toast.js';
import { Breadcrumb } from '../ui/breadcrumb.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';

function TabsHarness() {
  const [active, setActive] = useState('synthese');
  return (
    <Tabs
      label="Sections du contrat"
      active={active}
      onChange={setActive}
      tabs={[{ id: 'synthese', label: 'Synthèse' }, { id: 'contenu', label: 'Contenu' }, { id: 'historique', label: 'Historique' }]}
      panels={{ synthese: <p>Panneau synthèse</p>, contenu: <p>Panneau contenu</p>, historique: <p>Panneau historique</p> }}
    />
  );
}

test('onglets : rôles ARIA et navigation au clavier (flèches, Début, Fin)', async () => {
  const user = userEvent.setup();
  render(<TabsHarness />);
  expect(screen.getByRole('tablist', { name: 'Sections du contrat' })).toBeInTheDocument();
  const synthese = screen.getByRole('tab', { name: 'Synthèse' });
  expect(synthese).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Contenu' })).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Panneau synthèse');

  synthese.focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Contenu' })).toHaveFocus();
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Panneau contenu');
  await user.keyboard('{End}');
  expect(screen.getByRole('tab', { name: 'Historique' })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Synthèse' })).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByRole('tab', { name: 'Historique' })).toHaveFocus();
  await user.keyboard('{Home}');
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Panneau synthèse');
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Synthèse' }).id);
});

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Ouvrir</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Confirmer l'envoi">
        <button type="button">Premier</button>
        <button type="button">Dernier</button>
      </Modal>
    </>
  );
}

test('modale : dialogue nommé, focus piégé, Échap ferme et rend le focus', async () => {
  const user = userEvent.setup();
  render(<ModalHarness />);
  const opener = screen.getByRole('button', { name: 'Ouvrir' });
  await user.click(opener);
  const dialog = screen.getByRole('dialog', { name: "Confirmer l'envoi" });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Le premier focusable est le bouton Fermer de l'en-tête.
  expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Premier' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Dernier' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Dernier' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

function ToastHarness() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.show('Contrat enregistré')}>Succès</button>
      <button type="button" onClick={() => toast.show('Échec de l’envoi', 'danger')}>Erreur</button>
    </>
  );
}

test('toasts : succès annoncé poliment et fermé automatiquement, erreur en alerte persistante', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider duration={1000}><ToastHarness /></ToastProvider>);
    await user.click(screen.getByRole('button', { name: 'Succès' }));
    expect(screen.getByRole('status')).toHaveTextContent('Contrat enregistré');
    await user.click(screen.getByRole('button', { name: 'Erreur' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Échec de l’envoi');
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText('Contrat enregistré')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fermer la notification' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('fil d’Ariane : navigation nommée, page courante signalée', () => {
  render(
    <MemoryRouter>
      <Breadcrumb items={[{ label: 'Contrats', to: '/contracts' }, { label: 'CT-2026-001' }]} />
    </MemoryRouter>,
  );
  const nav = screen.getByRole('navigation', { name: "Fil d'Ariane" });
  expect(nav).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Contrats' })).toHaveAttribute('href', '/contracts');
  expect(screen.getByText('CT-2026-001')).toHaveAttribute('aria-current', 'page');
});

test('champ : libellé relié, erreur reliée par aria-describedby et aria-invalid', () => {
  render(
    <Field label="Référence" htmlFor="ref" error="Obligatoire">
      <Input id="ref" />
    </Field>,
  );
  const input = screen.getByLabelText('Référence');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription('Obligatoire');
});
