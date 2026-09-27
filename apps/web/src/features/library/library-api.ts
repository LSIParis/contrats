import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api.js';

/** Bibliothèque de clauses versionnées (apps/api/src/structure/clause-library.service.ts). */
export interface LibraryVersion {
  id: string;
  versionNumber: number;
  bodyHtml: string;
  variables: string[] | null;
  changeNote: string | null;
  createdAt: string;
}

export interface LibraryItem {
  id: string;
  code: string;
  category: string;
  title: string;
  isDemo: boolean;
  currentVersion: LibraryVersion | null;
}

export interface LibraryItemDetail {
  id: string;
  code: string;
  category: string;
  title: string;
  isDemo: boolean;
  archivedAt: string | null;
  currentVersionId: string | null;
  versions: LibraryVersion[];
}

export const libraryKey = ['clause-library'] as const;

export function useClauseLibrary(enabled = true) {
  return useQuery({
    queryKey: libraryKey,
    queryFn: () => apiGet<{ items: LibraryItem[] }>('/v1/clauses'),
    enabled,
  });
}

export function useLibraryClause(id: string | null) {
  return useQuery({
    queryKey: ['clause-library', id],
    queryFn: () => apiGet<LibraryItemDetail>(`/v1/clauses/${id}`),
    enabled: !!id,
  });
}

const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const htmlText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Recherche plein texte côté client : code, titre, texte de la version courante (sans accents). */
export function filterLibrary(items: readonly LibraryItem[], query: string, category = ''): LibraryItem[] {
  const q = fold(query.trim());
  return items.filter((i) => {
    if (category && i.category !== category) return false;
    if (!q) return true;
    const hay = fold(`${i.code} ${i.title} ${htmlText(i.currentVersion?.bodyHtml ?? '')}`);
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}
