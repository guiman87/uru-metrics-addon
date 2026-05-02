import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-UY,es;q=0.9,en;q=0.6',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// URL fragments that almost always indicate listing/archive/profile pages
// rather than a single article. Keep this generic — per-source overrides are
// possible later via the `sources` config.
const REJECT_PATH_FRAGMENTS = [
  '/category/',
  '/categoria/',
  '/categorias/',
  '/tag/',
  '/tags/',
  '/etiqueta/',
  '/page/',
  '/pagina/',
  '/author/',
  '/autor/',
  '/seccion/',
  '/buscar',
  '/search',
];

// Heuristics that suggest a link IS an article (year or noticias/articulo path
// segment, or a deep slug). At least one must match.
const ARTICLE_PATH_HINTS = [
  /\/20\d{2}\//, // /2024/, /2025/, /2026/...
  /\/noticia/,
  /\/articulo/,
  /\/article/,
  /\/news\//,
  /\/nota/,
];

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    // Remove well-known tracking params; preserve everything else.
    for (const k of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
    ]) {
      u.searchParams.delete(k);
    }
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

export interface SourceLike {
  domain: string;
  seedUrls: string[];
}

export async function discoverArticleUrls(
  source: SourceLike,
): Promise<{ urls: string[]; errors: string[] }> {
  const urls = new Set<string>();
  const errors: string[] = [];

  for (const seedUrl of source.seedUrls) {
    try {
      const { data } = await axios.get(seedUrl, {
        headers: BROWSER_HEADERS,
        httpsAgent,
        timeout: 15_000,
        maxRedirects: 5,
        decompress: true,
      });
      const $ = cheerio.load(data);
      $('a').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        if (REJECT_PATH_FRAGMENTS.some((f) => href.includes(f))) return;
        const isHinted = ARTICLE_PATH_HINTS.some((re) => re.test(href)) || href.length > 35;
        if (!isHinted) return;
        try {
          const full = new URL(href, seedUrl).toString();
          // Same-domain only (allow www. prefix variations).
          const linkHost = new URL(full).hostname.replace(/^www\./, '');
          const sourceHost = source.domain.replace(/^www\./, '');
          if (!linkHost.endsWith(sourceHost)) return;
          urls.add(normalizeUrl(full));
        } catch {
          /* skip malformed */
        }
      });
    } catch (err) {
      errors.push(`${seedUrl}: ${(err as Error).message}`);
    }
  }

  return { urls: [...urls], errors };
}
