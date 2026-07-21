import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../../lib/api.js';
import { notificationTypeLabel } from '../../lib/labels.js';

interface Notif {
  id: string;
  type: string;
  subject: string;
  body: string;
  relatedContractId: string | null;
  status: string;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiGet<{ items: Notif[]; unreadCount: number }>('/v1/notifications'),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readOne = useMutation({ mutationFn: (id: string) => apiPatch(`/v1/notifications/${id}/read`, {}), onSuccess: invalidate });
  const readAll = useMutation({ mutationFn: () => apiPost('/v1/notifications/read-all', {}), onSuccess: invalidate });

  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.items ?? [];

  const openNotif = (n: Notif) => {
    readOne.mutate(n.id);
    setOpen(false);
    if (n.relatedContractId) navigate(`/contracts/${n.relatedContractId}`);
  };

  return (
    <div className="relative">
      <button
        type="button" aria-label="Notifications" onClick={() => setOpen((o) => !o)}
        className="relative rounded p-1 hover:bg-gray-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded border bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-semibold">
            <span>Notifications</span>
            {unread > 0 && (
              <button type="button" onClick={() => readAll.mutate()} className="text-xs text-lsi hover:underline">
                Tout marquer lu
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-gray-400">Aucune notification.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button" onClick={() => openNotif(n)}
                    className={`flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-gray-50 ${n.readAt ? 'opacity-60' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      {!n.readAt && <span className="h-2 w-2 rounded-full bg-red-600" />}
                      <span className="font-medium">{n.subject}</span>
                    </span>
                    <span className="text-xs text-gray-500">{notificationTypeLabel(n.type)} · {new Date(n.createdAt).toLocaleDateString('fr-FR')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
