import type { ReactNode } from 'react';
export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="border-b text-left text-gray-500">{head}</thead>
      <tbody>{children}</tbody>
    </table>
  );
}
