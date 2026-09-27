import { useState } from 'react';
import { Button } from '../../ui/button.js';
import { Icon } from '../../ui/icons.js';

export interface SigningSession {
  alreadySigned: boolean;
  embedSrc: string | null;
}

/** Message français d'une erreur de signature (503 DOCUSEAL_DISABLED / DOCUSEAL_UNAVAILABLE, 404…). */
export function signingErrorMessage(e: unknown): string {
  const err = e as { code?: string; status?: number; message?: string } | null;
  if (err?.code === 'DOCUSEAL_DISABLED') return 'La signature électronique n’est pas activée pour votre organisation.';
  if (err?.code === 'DOCUSEAL_UNAVAILABLE') return 'Le service de signature électronique est momentanément indisponible. Réessayez plus tard.';
  if (err?.status === 404) return 'Aucune signature en attente pour vous sur ce contrat.';
  return err?.message && !/^(API|Portail|Erreur) \d{3}/.test(err.message) ? err.message : 'Signature indisponible.';
}

/**
 * Signature INTÉGRÉE (brief §7, `embed_src`) : le formulaire DocuSeal du
 * signataire connecté s'affiche dans un cadre de la page (la CSP autorise
 * l'origine DocuSeal en frame-src). L'URL est demandée au moment du clic.
 */
export function EmbeddedSigning({ load, buttonLabel, frameTitle, onDone }: {
  load: () => Promise<SigningSession>;
  buttonLabel: string;
  frameTitle: string;
  onDone?: () => void;
}) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'signed' | 'error'; src?: string; error?: string }>({ status: 'idle' });

  async function start() {
    setState({ status: 'loading' });
    try {
      const s = await load();
      if (s.alreadySigned || !s.embedSrc) setState({ status: 'signed' });
      else setState({ status: 'ready', src: s.embedSrc });
    } catch (e) {
      setState({ status: 'error', error: signingErrorMessage(e) });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {state.status !== 'ready' && (
        <div>
          <Button type="button" onClick={start} disabled={state.status === 'loading'}>
            <Icon name="pen" />
            {state.status === 'loading' ? 'Préparation de la signature…' : buttonLabel}
          </Button>
        </div>
      )}
      {state.status === 'signed' && <p role="status" className="text-sm text-success">Vous avez déjà signé ce document.</p>}
      {state.status === 'error' && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      {state.status === 'ready' && state.src && (
        <>
          <iframe
            src={state.src}
            title={frameTitle}
            className="h-[760px] w-full rounded-lg border border-line bg-surface"
            allow="camera 'none'; microphone 'none'"
          />
          <div className="flex flex-wrap items-center gap-3 text-13 text-ink-muted">
            <span>Une fois la signature terminée, actualisez l’état du contrat.</span>
            <Button type="button" size="sm" variant="secondary" onClick={() => { setState({ status: 'idle' }); onDone?.(); }}>
              J’ai terminé — actualiser
            </Button>
            <a href={state.src} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Ouvrir dans un nouvel onglet</a>
          </div>
        </>
      )}
    </div>
  );
}
