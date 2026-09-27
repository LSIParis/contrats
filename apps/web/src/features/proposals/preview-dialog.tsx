import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { proposalsApi } from './proposal-api.js';

/**
 * Aperçu de la version courante : HTML produit et ASSAINI par le serveur
 * (`GET /v1/proposals/:id/preview`, même rendu que le PDF), affiché dans un
 * cadre isolé (`sandbox` vide : ni script, ni formulaire, ni navigation).
 * Bureau / mobile : largeur du cadre (390 px ≈ téléphone).
 */
export function PreviewDialog({ proposalId, number, onClose }: { proposalId: string; number: string; onClose: () => void }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const q = useQuery({ queryKey: ['proposal-preview', proposalId], queryFn: () => proposalsApi.preview(proposalId), staleTime: 0 });
  return (
    <Modal open onClose={onClose} title="Aperçu de la proposition" width={1000}>
      <div className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Affichage" className="flex gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="apercu-appareil" checked={device === 'desktop'} onChange={() => setDevice('desktop')} /> Bureau
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="apercu-appareil" checked={device === 'mobile'} onChange={() => setDevice('mobile')} /> Mobile
          </label>
        </div>
        {q.isLoading ? (
          <Spinner label="Rendu de l’aperçu…" />
        ) : q.error ? (
          <ErrorNote>{errorMessage(q.error, 'Aperçu indisponible.')}</ErrorNote>
        ) : (
          <div className="flex justify-center rounded border border-line bg-slate-50 p-2">
            <iframe
              title={`Aperçu de la proposition ${number}`}
              sandbox=""
              srcDoc={q.data?.html ?? ''}
              style={{ width: device === 'mobile' ? '390px' : '100%' }}
              className="h-[65vh] rounded border border-line bg-surface"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
