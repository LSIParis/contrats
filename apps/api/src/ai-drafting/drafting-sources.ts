import type { SourceRef } from './contract-drafting-provider.port.js';

/**
 * Politique des sources (brief §6.3) : une source citée provient UNIQUEMENT
 * des métadonnées de la réponse (résultats de recherche, contenus récupérés,
 * annotations de citation) — jamais d'une URL écrite par le modèle dans le
 * texte, qui peut être inventée ou mal formée (la documentation Perplexity le
 * dit elle-même).
 *
 * Les URL trouvées dans le texte généré sont donc RETIRÉES du texte et
 * signalées (`removedUrls`), pour que le relecteur sache qu'elles existaient.
 */

/** URL explicites, `www.…`, et domaines nus des TLD courants (ex. « legifrance.gouv.fr/… »). */
const URL_IN_TEXT_RE =
  /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"'`)\]]+|(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:fr|com|org|net|eu|io|info|gouv\.fr)(?![\w-])(?:\/[^\s<>"'`)\]]*)?/gi;

/** Marqueurs de citation ([1], [web:3], [page:2]) — jamais nos jetons ([CLIENT], [MONTANT_1]). */
const CITATION_MARKER_RE = /\[(?:web|page|source)?:?\d+\]/gi;

export interface StrippedText {
  readonly text: string;
  readonly removedUrls: readonly string[];
}

export function stripUrlsAndMarkers(input: string): StrippedText {
  const removedUrls: string[] = [];
  let text = input.replace(URL_IN_TEXT_RE, (url) => {
    // La ponctuation finale appartient à la phrase, pas à l'URL : on la rend au texte.
    const trailing = /[.,;:!?]+$/.exec(url)?.[0] ?? '';
    removedUrls.push(url.slice(0, url.length - trailing.length));
    return trailing;
  });
  text = text
    .replace(CITATION_MARKER_RE, '')
    // Nettoyage des restes : « (voir ) », espaces avant ponctuation, doubles espaces.
    .replace(/\(\s*(?:voir|cf\.?|source\s*:?)?\s*\)/gi, '')
    .replace(/[ \t]+([.,;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { text, removedUrls };
}

function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Sources d'une réponse Agent API Perplexity : items `search_results`
 * (`results[]`), `fetch_url_results` (`contents[]`) et annotations
 * `url_citation` des messages. Dédoublonnées par URL, ordre d'apparition.
 */
export function extractPerplexitySources(output: readonly unknown[]): SourceRef[] {
  const out = new Map<string, SourceRef>();
  const add = (s: SourceRef) => {
    if (!out.has(s.url)) out.set(s.url, s);
  };
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it.type === 'search_results' && Array.isArray(it.results)) {
      for (const r of it.results as Record<string, unknown>[]) {
        if (!isHttpUrl(r?.url)) continue;
        const snippet = clip(str(r.snippet), 500);
        const date = str(r.date) ?? str(r.last_updated);
        add({ url: r.url, title: str(r.title) ?? r.url, origin: 'search_result', ...(snippet ? { snippet } : {}), ...(date ? { date } : {}) });
      }
    } else if (it.type === 'fetch_url_results' && Array.isArray(it.contents)) {
      for (const c of it.contents as Record<string, unknown>[]) {
        if (!isHttpUrl(c?.url)) continue;
        const snippet = clip(str(c.snippet), 500);
        add({ url: c.url, title: str(c.title) ?? c.url, origin: 'fetch_url', ...(snippet ? { snippet } : {}) });
      }
    } else if (it.type === 'message' && Array.isArray(it.content)) {
      for (const part of it.content as Record<string, unknown>[]) {
        if (!Array.isArray(part?.annotations)) continue;
        for (const a of part.annotations as Record<string, unknown>[]) {
          if (!isHttpUrl(a?.url)) continue;
          add({ url: a.url, title: str(a.title) ?? a.url, origin: 'citation' });
        }
      }
    }
  }
  return [...out.values()];
}
