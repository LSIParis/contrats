import type { ReactNode } from 'react';
import { STATUS_TONES, type StatusTone } from './theme/status.js';

/**
 * Pastille générique — `.badge` de lticket (styles.css l. 287-307) : pilule, 12 px, graisse 600,
 * texte coloré sur son propre fond clair (≥ 4,5:1).
 */
export function Badge({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-[9px] py-0.5 align-middle text-xs font-semibold leading-[1.6] ${STATUS_TONES[tone].className}`}
    >
      {children}
    </span>
  );
}

// Compatibilité : les pages importent historiquement le badge de statut depuis ce module.
export { StatusBadge } from './status-badge.js';
