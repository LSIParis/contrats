import { Badge } from '../../ui/badge.js';
import { Icon } from '../../ui/icons.js';

/** Pastille « Importé » : contrat signé hors plateforme (origin LEGACY_IMPORT). Icône + texte. */
export function ImportedBadge() {
  return (
    <Badge tone="info">
      <Icon name="download" className="h-3.5 w-3.5" strokeWidth={2} />
      Importé
    </Badge>
  );
}
