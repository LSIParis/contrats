import { Card } from '../../ui/card.js';
export interface Reminder { kind: string; offsetDays: number; dueAt: string; status: string; late: boolean; }
export function RemindersBlock({ reminders }: { reminders: Reminder[] }) {
  return (
    <Card title="Rappels">
      {reminders.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun rappel.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {reminders.map((r, i) => (
            <li key={i} className="flex justify-between">
              <span>J-{r.offsetDays} · {new Date(r.dueAt).toLocaleDateString('fr-FR')}</span>
              <span className={r.late ? 'text-red-600' : 'text-gray-600'}>{r.status}{r.late ? ' (retard)' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
