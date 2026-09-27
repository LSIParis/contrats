import { contractStatusLabel, isContractStatus } from '../lib/labels.js';
import { Icon } from './icons.js';
import { STATUS_STYLES, STATUS_TONES } from './theme/status.js';

/**
 * Badge de statut du cycle de vie d'un contrat : une couleur, une icône, un libellé français.
 * Gabarit de la pastille lticket (styles.css l. 287-292) : pilule, 12 px, graisse 600.
 * Un statut inconnu retombe sur le ton neutre et le code brut (jamais « undefined »).
 */
export function StatusBadge({ status }: { status: string }) {
  const style = isContractStatus(status) ? STATUS_STYLES[status] : undefined;
  const tone = STATUS_TONES[style?.tone ?? 'neutral'];
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-[9px] py-0.5 align-middle text-xs font-semibold leading-[1.6] ${tone.className}`}
    >
      {style && <Icon name={style.icon} className="h-3.5 w-3.5" strokeWidth={2} />}
      {contractStatusLabel(status)}
    </span>
  );
}
