import { Link } from 'react-router-dom';
import { Card } from '../../ui/card.js';

export interface ContractCard {
  id: string; reference: string; title: string;
  customerName: string; status: string; endDate: string | null;
}
export interface ExpiringData { j30: ContractCard[]; j60: ContractCard[]; j90: ContractCard[]; }

function Column({ label, items }: { label: string; items: ContractCard[] }) {
  return (
    <Card title={label}>
      {items.length === 0 ? (
        <p className="text-sm text-gray-400">Aucun contrat</p>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id}>
              <Link to={`/contracts/${c.id}`} className="block hover:underline">
                <span className="font-medium">{c.reference}</span>
                <span className="text-gray-500"> — {c.customerName}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ExpiringColumns({ data }: { data: ExpiringData }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Column label="Expire sous 30 jours" items={data.j30} />
      <Column label="31 à 60 jours" items={data.j60} />
      <Column label="61 à 90 jours" items={data.j90} />
    </div>
  );
}
