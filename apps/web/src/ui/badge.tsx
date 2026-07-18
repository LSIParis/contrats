const COLORS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800', DRAFT: 'bg-gray-100 text-gray-700',
  PENDING_SIGNATURE: 'bg-amber-100 text-amber-800', EXPIRED: 'bg-red-100 text-red-800',
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${COLORS[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  );
}
