import { render, screen } from '@testing-library/react';
import { SignatureBlock } from '../features/contracts/signature-block.js';

test('rend chaque signataire avec son statut', () => {
  render(
    <SignatureBlock
      data={{ status: 'COMPLETED', signers: [
        { party: 'LSI', fullName: 'Marc D.', status: 'SIGNED', signedAt: '2026-07-01' },
        { party: 'CLIENT', fullName: 'J. Dupont', status: 'SENT', signedAt: null },
      ] }}
    />,
  );
  expect(screen.getByText('Marc D.')).toBeInTheDocument();
  expect(screen.getByText('J. Dupont')).toBeInTheDocument();
  expect(screen.getByText(/SIGNED/)).toBeInTheDocument();
  expect(screen.getByText(/SENT/)).toBeInTheDocument();
});

test('sans demande de signature, affiche un état vide', () => {
  render(<SignatureBlock data={null} />);
  expect(screen.getByText(/Aucune demande de signature/i)).toBeInTheDocument();
});
