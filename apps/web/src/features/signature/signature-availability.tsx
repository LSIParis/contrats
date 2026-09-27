import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Icon } from '../../ui/icons.js';

/** GET /v1/signature/availability (apps/api/src/signature/signature-availability.service.ts). */
export interface SignatureAvailability {
  configured: boolean;
  available: boolean;
  enabled: boolean;
}

export function useSignatureAvailability() {
  return useQuery({
    queryKey: ['signature-availability'],
    queryFn: () => apiGet<SignatureAvailability>('/v1/signature/availability'),
    staleTime: 30_000,
  });
}

export function signatureUnavailableReason(a: SignatureAvailability | undefined): string | null {
  if (!a || a.enabled) return null;
  return a.configured
    ? 'Le service de signature électronique est momentanément indisponible : aucun envoi n’est possible pour l’instant. Le contrat reste en l’état ; réessayez plus tard.'
    : 'La signature électronique n’est pas activée pour votre organisation (paramètre contrats.docuseal.enabled).';
}

/** Bandeau : la signature est neutralisée, le reste de l'application fonctionne (brief §7). */
export function SignatureAvailabilityBanner({ availability }: { availability: SignatureAvailability | undefined }) {
  const reason = signatureUnavailableReason(availability);
  if (!reason) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-warn bg-warn-bg px-4 py-3 text-sm text-warn">
      <Icon name="alert" className="mt-0.5 h-4 w-4" />
      <span>{reason}</span>
    </p>
  );
}
