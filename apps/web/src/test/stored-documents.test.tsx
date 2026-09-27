import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { StoredDocuments } from '../features/contracts/stored-documents.js';

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

test('liste les pièces conservées avec lien de téléchargement et empreinte', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{
    id: 'd1', kind: 'SIGNATURE_AUDIT_TRAIL', label: 'Dossier de preuve de signature', origin: 'DOCUSEAL',
    filename: 'audit.pdf', contentType: 'application/pdf', sizeBytes: '2048', sha256: 'ab'.repeat(32), createdAt: '2026-09-27T10:00:00Z',
  }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap(<StoredDocuments contractId="k1" />);
  expect(await screen.findByText('Dossier de preuve de signature')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'audit.pdf' })).toHaveAttribute('href', '/v1/contracts/k1/documents/d1');
  expect(screen.getByText(/SHA-256 abab/)).toBeInTheDocument();
});
