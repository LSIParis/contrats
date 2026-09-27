import { useEffect, useRef } from 'react';
import { publicApi } from './public-api.js';

/**
 * Suivi de lecture de la page publique (brief §12.5) — AUCUN traceur tiers :
 * les événements partent uniquement vers l'API de l'application.
 *
 *   - `OPENED` au chargement ;
 *   - temps de lecture PAR SECTION : IntersectionObserver (section visible à ≥ 40 %),
 *     chronomètre suspendu quand l'onglet est masqué ;
 *   - envoi GROUPÉ : toutes les 15 s, et au masquage / départ de la page
 *     (`fetch` keepalive), au plus 50 événements par envoi ;
 *   - `viewerId` : identifiant aléatoire du navigateur (stockage local), haché côté
 *     serveur ; il sert à repérer un lien transféré, rien d'autre.
 */
type TrackEvent = { type: 'OPENED' | 'SECTION_VIEWED' | 'PDF_DOWNLOADED'; sectionKey?: string; durationMs?: number };

const VIEWER_KEY = 'proposition-lecteur';
const FLUSH_MS = 15_000;
const MIN_SECTION_MS = 1_000;

export function viewerId(): string | undefined {
  try {
    let id = localStorage.getItem(VIEWER_KEY);
    if (!id) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(VIEWER_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

export function useReadingTracker(token: string, enabled: boolean, sectionKeys: readonly string[]) {
  const queue = useRef<TrackEvent[]>([]);
  const opened = useRef(false);

  const flush = (keepalive = false) => {
    while (queue.current.length) {
      const events = queue.current.splice(0, 50);
      const vid = viewerId();
      void publicApi.events(token, { ...(vid ? { viewerId: vid } : {}), events }, keepalive).catch(() => {
        /* suivi best-effort : jamais bloquant pour le lecteur */
      });
    }
  };

  useEffect(() => {
    if (!enabled || opened.current) return;
    opened.current = true;
    queue.current.push({ type: 'OPENED' });
    flush();
  }, [enabled, token]);

  const keys = sectionKeys.join('|');
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const visibleSince = new Map<string, number>();
    const stop = (key: string) => {
      const since = visibleSince.get(key);
      if (since === undefined) return;
      visibleSince.delete(key);
      const durationMs = Math.min(Date.now() - since, 3_600_000);
      if (durationMs >= MIN_SECTION_MS) queue.current.push({ type: 'SECTION_VIEWED', sectionKey: key, durationMs });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.sectionKey;
          if (!key) continue;
          if (e.isIntersecting && document.visibilityState === 'visible') visibleSince.set(key, Date.now());
          else stop(key);
        }
      },
      { threshold: 0.4 },
    );
    document.querySelectorAll<HTMLElement>('[data-section-key]').forEach((el) => observer.observe(el));
    const stopAll = () => [...visibleSince.keys()].forEach(stop);
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        stopAll();
        flush(true);
      }
    };
    const onPageHide = () => {
      stopAll();
      flush(true);
    };
    const timer = window.setInterval(() => {
      // Sections encore visibles : on comptabilise la tranche écoulée et on repart.
      const now = Date.now();
      for (const key of [...visibleSince.keys()]) {
        stop(key);
        visibleSince.set(key, now);
      }
      flush();
    }, FLUSH_MS);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      stopAll();
      flush(true);
    };
  }, [enabled, token, keys]);

  return {
    track: (e: TrackEvent) => {
      queue.current.push(e);
      flush();
    },
  };
}
