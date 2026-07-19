import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowActions } from '../features/contracts/workflow-actions.js';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test('un valideur (non soumetteur) voit Approuver et peut approuver', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(String(url)).toContain('/approve');
    expect(init?.method).toBe('POST');
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock as never);
  wrap(<WorkflowActions contractId="k1" status="IN_REVIEW" allowedActions={['APPROVE', 'REQUEST_CHANGES']} roles={['MSP_ADMIN']} currentUserId="reviewer" approval={{ submittedByUserId: 'author', decision: 'PENDING', reason: null, decidedByUserId: null }} />);
  await userEvent.click(screen.getByRole('button', { name: /Approuver/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
});

test('le soumetteur ne voit PAS Approuver (RM-10)', () => {
  wrap(<WorkflowActions contractId="k1" status="IN_REVIEW" allowedActions={['APPROVE', 'REQUEST_CHANGES']} roles={['MSP_ADMIN']} currentUserId="author" approval={{ submittedByUserId: 'author', decision: 'PENDING', reason: null, decidedByUserId: null }} />);
  expect(screen.queryByRole('button', { name: /Approuver/ })).not.toBeInTheDocument();
});
