import { Card } from '../../ui/card.js';
export interface Event { at: string; type: string; label: string; }
export function Timeline({ events }: { events: Event[] }) {
  return (
    <Card title="Historique">
      {events.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun historique.</p>
      ) : (
        <ol className="space-y-1 text-sm">
          {events.map((e, i) => (
            <li key={i}><span className="text-gray-400">{new Date(e.at).toLocaleString('fr-FR')}</span> — {e.label}</li>
          ))}
        </ol>
      )}
    </Card>
  );
}
