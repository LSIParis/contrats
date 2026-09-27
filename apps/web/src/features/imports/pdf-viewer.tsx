import { useEffect, useState } from 'react';

/**
 * Aperçu PDF intégré.
 *
 * Le document est chargé par `fetch` puis affiché depuis une URL `blob:` plutôt que par
 * l'URL de l'API directement :
 *   - `GET /v1/contracts/:id/imported-document` répond `Content-Disposition: attachment`
 *     (un iframe déclencherait un téléchargement au lieu d'un affichage) ;
 *   - le proxy pose `X-Frame-Options: DENY` (09-exploitation.md §5.2), qui interdit
 *     d'encadrer toute réponse HTTP, même de même origine. Une URL `blob:` n'est pas
 *     une réponse HTTP : elle n'y est pas soumise.
 * Sans `URL.createObjectURL` (environnement de test), on retombe sur l'URL directe.
 */
export function usePdfObjectUrl(src: string | null): { url: string | null; error: boolean; loading: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean; loading: boolean }>({
    url: null, error: false, loading: Boolean(src),
  });

  useEffect(() => {
    if (!src) {
      setState({ url: null, error: false, loading: false });
      return;
    }
    if (typeof URL.createObjectURL !== 'function') {
      setState({ url: src, error: false, loading: false });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, error: false, loading: true });
    fetch(src, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setState({ url: objectUrl, error: false, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, error: true, loading: false });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  return state;
}

export function PdfFrame({ src, title, downloadHref }: { src: string; title: string; downloadHref: string }) {
  const { url, error, loading } = usePdfObjectUrl(src);
  if (loading) return <p role="status" className="p-6 text-center text-ink-muted">Chargement du document…</p>;
  if (error || !url) {
    return (
      <p role="alert" className="p-6 text-center text-danger">
        Aperçu indisponible. <a href={downloadHref} className="text-primary underline">Télécharger le document</a>
      </p>
    );
  }
  return <iframe src={url} title={title} className="h-[75vh] w-full rounded border border-line bg-white" />;
}
