import { contractStatusLabel } from '../lib/labels.js';

const COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  IN_REVIEW: 'bg-blue-100 text-blue-800',
  CHANGES_REQUESTED: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-teal-100 text-teal-800',
  PENDING_SIGNATURE: 'bg-amber-100 text-amber-800',
  PARTIALLY_SIGNED: 'bg-amber-100 text-amber-800',
  SIGNED: 'bg-teal-100 text-teal-800',
  ACTIVE: 'bg-green-100 text-green-800',
  EXPIRED: 'bg-red-100 text-red-800',
  TERMINATED: 'bg-red-100 text-red-800',
  RENEWED: 'bg-blue-100 text-blue-800',
  CANCELLED: 'bg-gray-100 text-gray-700',
  DECLINED: 'bg-red-100 text-red-800',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${COLORS[status] ?? 'bg-gray-100 text-gray-700'}`}
    >
      {contractStatusLabel(status)}
    </span>
  );
}
