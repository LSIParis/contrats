import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../../lib/api.js';

/** POST sur une route d'action du contrat, puis rafraîchit fiche, actions permises et journal. */
export function useContractAction<T = unknown>(contractId: string, path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown = {}) => apiPost<T>(`/v1/contracts/${contractId}/${path}`, body),
    onSuccess: () => {
      for (const key of [['contract', contractId], ['allowed-actions', contractId], ['lifecycle', contractId], ['acceptances', contractId], ['deadlines']]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}
