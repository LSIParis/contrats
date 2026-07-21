import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Card } from '../../ui/card.js';
import { Button } from '../../ui/button.js';
import { actorKindLabel } from '../../lib/labels.js';

interface AuditItem {
  id: string; occurredAt: string; actorUserId: string | null; actorKind: string;
  action: string; resourceType: string; resourceId: string | null; requestId: string | null;
}

export function AuditPage() {
  const [resourceType, setResourceType] = useState('');
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; brokenAt: string | null } | null>(null);
  const q = useQuery({
    queryKey: ['audit', resourceType],
    queryFn: () => apiGet<{ items: AuditItem[] }>(`/v1/audit${resourceType ? `?resourceType=${encodeURIComponent(resourceType)}` : ''}`),
  });
  const verify = async () => setVerifyResult(await apiGet<{ ok: boolean; brokenAt: string | null }>(`/v1/audit/verify`));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Journal d'audit</h1>
        <Button onClick={verify}>Vérifier l'intégrité</Button>
      </div>
      {verifyResult && (
        <p className={`text-sm ${verifyResult.ok ? 'text-green-700' : 'text-red-600'}`}>
          {verifyResult.ok ? '✓ Chaîne intègre' : `⚠ Rupture détectée à l'entrée ${verifyResult.brokenAt}`}
        </p>
      )}
      <input
        value={resourceType} onChange={(e) => setResourceType(e.target.value)}
        placeholder="Filtrer par type de ressource (ex. contracts)"
        className="w-72 rounded border border-gray-300 p-2 text-sm"
      />
      <Card title="Entrées">
        {q.isLoading ? <Spinner /> : (
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500">
              <tr><th className="py-1">Date</th><th>Acteur</th><th>Action</th><th>Ressource</th></tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="py-1">{new Date(e.occurredAt).toLocaleString('fr-FR')}</td>
                  <td>{e.actorUserId ?? actorKindLabel(e.actorKind)}</td>
                  <td className="font-mono text-xs">{e.action}</td>
                  <td>{e.resourceType}{e.resourceId ? ` · ${e.resourceId.slice(0, 8)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
