import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { ExpiringColumns } from '../features/dashboard/expiring.js';

const data = {
  j30: [{ id: 'a', reference: 'LSI-A', title: 'T', customerName: 'Dupont', status: 'ACTIVE', endDate: '2026-08-01' }],
  j60: [],
  j90: [],
};

test('affiche les contrats du bucket J-30 avec un lien vers la fiche', () => {
  render(<MemoryRouter><ExpiringColumns data={data as never} /></MemoryRouter>);
  expect(screen.getByText('LSI-A')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /LSI-A/ })).toHaveAttribute('href', '/contracts/a');
});

test('un bucket vide affiche un état vide', () => {
  render(<MemoryRouter><ExpiringColumns data={data as never} /></MemoryRouter>);
  expect(screen.getAllByText(/Aucun contrat/i).length).toBeGreaterThanOrEqual(2);
});
