import { render, screen } from '@testing-library/react';
import { Timeline } from '../features/contracts/timeline.js';

test('sans événement, affiche un état vide', () => {
  render(<Timeline events={[]} />);
  expect(screen.getByText('Aucun historique.')).toBeInTheDocument();
});

test('avec des événements, affiche chaque libellé', () => {
  render(
    <Timeline
      events={[
        { at: '2026-07-01T10:00:00Z', type: 'CREATED', label: 'Contrat créé' },
        { at: '2026-07-05T10:00:00Z', type: 'SIGNED', label: 'Signature complétée' },
      ]}
    />,
  );
  expect(screen.getByText(/Contrat créé/)).toBeInTheDocument();
  expect(screen.getByText(/Signature complétée/)).toBeInTheDocument();
  expect(screen.queryByText('Aucun historique.')).not.toBeInTheDocument();
});
