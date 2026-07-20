import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PortalSignatureCompletePage } from '../portal/portal-signature-complete-page.js';

// Page de retour DocuSeal : elle doit s'afficher sans session ni fetch, car
// l'utilisateur y arrive juste après avoir signé hors de l'app (redirection
// DocuSeal), potentiellement sans cookie de session valide à ce moment-là.
test('affiche le message de confirmation sans fetch ni session', () => {
  render(<MemoryRouter initialEntries={['/portal/signature-complete']}><PortalSignatureCompletePage /></MemoryRouter>);
  expect(screen.getByText('Merci')).toBeInTheDocument();
  expect(screen.getByText(/signature a bien été enregistrée/)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: /Revenir à mes contrats/ });
  expect(link).toHaveAttribute('href', '/portal/contracts');
});
