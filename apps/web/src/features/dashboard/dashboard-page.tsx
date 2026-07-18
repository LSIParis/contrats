import { Link } from 'react-router-dom';
import { useDashboard } from '../../lib/queries.js';
import { Spinner } from '../../ui/spinner.js';
import { Card } from '../../ui/card.js';
import { ExpiringColumns } from './expiring.js';

export function DashboardPage() {
  const q = useDashboard();
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Erreur de chargement.</p>;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tableau de bord</h1>
      <ExpiringColumns data={q.data.expiring} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Object.entries(q.data.countsByStatus).map(([status, n]) => (
          <Link key={status} to={`/contracts?status=${status}`}>
            <Card title={status}><div className="text-3xl font-bold">{n}</div></Card>
          </Link>
        ))}
        <Card title="Rappels en attente">
          <div className="text-3xl font-bold">{q.data.pendingReminders}</div>
        </Card>
      </div>
    </div>
  );
}
