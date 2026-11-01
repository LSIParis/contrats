import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { PortalApp } from '../portal/portal-app';

vi.mock('../portal/portal-layout.js', () => ({ PortalLayout: () => <Outlet /> }));
vi.mock('../portal/portal-contracts-page.js', () => ({ PortalContractsPage: () => <p>Liste des contrats</p> }));
vi.mock('../portal/portal-contract-page.js', () => ({ PortalContractPage: () => <p>Contrat</p> }));
vi.mock('../portal/portal-login-page.js', () => ({ PortalLoginPage: () => <p>Connexion</p> }));
vi.mock('../portal/portal-signature-complete-page.js', () => ({ PortalSignatureCompletePage: () => <p>Signature</p> }));

function Where() {
  return <output>{useLocation().pathname}</output>;
}

describe('routes du portail sous /portal/*', () => {
  test('/portal redirige vers /portal/contracts', () => {
    render(
      <MemoryRouter initialEntries={['/portal']}>
        <Where />
        <Routes>
          <Route path="/portal/*" element={<PortalApp />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('/portal/contracts');
    expect(screen.getByText('Liste des contrats')).toBeInTheDocument();
  });
});
