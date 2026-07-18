import { Card } from '../../ui/card.js';

export interface Signer { party: string; fullName: string; status: string; signedAt: string | null; }
export interface SignatureData { status: string; signers: Signer[]; }

export function SignatureBlock({ data }: { data: SignatureData | null }) {
  return (
    <Card title="Signature">
      {!data ? (
        <p className="text-sm text-gray-400">Aucune demande de signature.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {data.signers.map((s, i) => (
            <li key={i} className="flex justify-between">
              <span>{s.fullName} <span className="text-gray-400">({s.party})</span></span>
              <span className="font-medium">{s.status}{s.signedAt ? ` · ${new Date(s.signedAt).toLocaleDateString('fr-FR')}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
