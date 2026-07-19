import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';
import { Spinner } from '../../ui/spinner.js';
import { Card } from '../../ui/card.js';
import { AddContactForm } from './add-contact-form.js';

interface Contact { id: string; firstName: string; lastName: string; email: string; phone: string | null; jobTitle: string | null; isPrimary: boolean; }
interface CustomerDetail {
  customer: { id: string; name: string; siren: string | null; city: string | null; country: string; status: string };
  contacts: Contact[];
}

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => apiGet<CustomerDetail>(`/v1/customers/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-red-600">Client introuvable.</p>;
  const { customer, contacts } = q.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{customer.name}</h1>
          <p className="text-sm text-gray-500">{customer.siren ? `SIREN ${customer.siren} · ` : ''}{customer.city ?? ''} ({customer.country})</p>
        </div>
        <Link to={`/contracts/new?customerId=${customer.id}`} className="rounded bg-lsi px-4 py-2 text-sm text-white hover:bg-lsi-dark">Nouveau contrat</Link>
      </div>
      <Card title="Contacts">
        {contacts.length === 0 ? (
          <p className="text-sm text-gray-400">Aucun contact.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {contacts.map((c) => (
              <li key={c.id} className="flex justify-between">
                <span>{c.firstName} {c.lastName}{c.isPrimary ? ' (principal)' : ''}</span>
                <span className="text-gray-500">{c.email}</span>
              </li>
            ))}
          </ul>
        )}
        <AddContactForm customerId={customer.id} />
      </Card>
    </div>
  );
}
