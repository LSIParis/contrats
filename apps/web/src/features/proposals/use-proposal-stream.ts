import { useEffect, useRef, useState } from 'react';

/**
 * Flux temps réel du commercial (`GET /v1/proposals/stream`, SSE, événement
 * `proposal`) : première ouverture, question, option modifiée, acceptation,
 * signature, refus, échec de conversion… (11-propositions.md §7).
 *
 * Dégradation propre : sans `EventSource` (tests, vieux navigateur) ou si le
 * flux tombe, l'écran reste utilisable — les données se rechargent à la
 * navigation et après chaque action. Le navigateur se reconnecte seul.
 */
export interface StreamMessage {
  userId: string;
  proposalId: string;
  type: string;
  subject: string;
  at: string;
}

export type StreamState = 'unsupported' | 'connecting' | 'open' | 'error';

export function useProposalStream(onMessage: (m: StreamMessage) => void): StreamState {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const [state, setState] = useState<StreamState>(() => (typeof EventSource === 'undefined' ? 'unsupported' : 'connecting'));

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let es: EventSource;
    try {
      es = new EventSource('/v1/proposals/stream', { withCredentials: true });
    } catch {
      setState('error');
      return undefined;
    }
    const onProposal = (e: MessageEvent) => {
      try {
        handler.current(JSON.parse(String(e.data)) as StreamMessage);
      } catch {
        /* message illisible : ignoré */
      }
    };
    es.addEventListener('proposal', onProposal as EventListener);
    es.onopen = () => setState('open');
    es.onerror = () => setState('error');
    return () => {
      es.removeEventListener('proposal', onProposal as EventListener);
      es.close();
    };
  }, []);

  return state;
}
