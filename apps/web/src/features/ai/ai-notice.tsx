import { Icon } from '../../ui/icons.js';
import { aiSourceList } from '../structure/structure-api.js';
import { providerLabel, type AiSource } from './ai-api.js';

/**
 * Mention OBLIGATOIRE avant tout appel IA (brief §6, §10) : seul du texte
 * pseudonymisé part chez le fournisseur choisi par l'organisation.
 */
export function AiPrivacyNotice({ provider }: { provider: string | null | undefined }) {
  return (
    <p className="flex items-start gap-2 rounded border border-info bg-info-bg px-3 py-2 text-13 text-info">
      <Icon name="shield" className="mt-0.5 h-4 w-4" />
      <span>
        Le texte est <strong>pseudonymisé</strong> avant envoi : nom du client, SIREN, adresses, e-mails, personnes et montants
        sont remplacés par des jetons ([CLIENT], [MONTANT_1]…) et réinjectés ici après la réponse. Ce texte pseudonymisé est
        transmis au fournisseur IA de votre organisation : <strong>{providerLabel(provider)}</strong>.
      </span>
    </p>
  );
}

/** Bandeau d'indisponibilité : le bouton reste visible mais expliqué. */
export function AiUnavailable({ reason }: { reason: string }) {
  return (
    <p role="note" className="flex items-center gap-2 text-13 text-ink-muted">
      <Icon name="info" /> {reason}
    </p>
  );
}

/** Sources et avertissements d'une réponse IA. */
export function AiSources({ sources, warnings }: { sources: AiSource[] | undefined; warnings?: string[] }) {
  const list = aiSourceList(sources ?? []);
  return (
    <>
      {warnings && warnings.length > 0 && (
        <ul className="ml-4 list-disc text-13 text-warn">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      {list.length > 0 && (
        <div className="text-13">
          <p className="font-button text-ink">Sources citées</p>
          <ul className="ml-4 list-disc">
            {list.map((s) => (
              <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{s.title}</a></li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
