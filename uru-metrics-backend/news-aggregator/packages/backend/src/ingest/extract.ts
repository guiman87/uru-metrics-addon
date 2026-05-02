import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'node:https';
import type { ScrapedArticle } from '@uru/shared';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-UY,es;q=0.9,en;q=0.6',
  'Accept-Encoding': 'gzip, deflate, br',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const FRESHNESS_DAYS = 30;

function absolutize(maybeUrl: string | undefined, base: string): string | null {
  if (!maybeUrl) return null;
  try {
    if (maybeUrl.startsWith('http')) return maybeUrl;
    if (maybeUrl.startsWith('//')) return 'https:' + maybeUrl;
    return new URL(maybeUrl, base).toString();
  } catch {
    return null;
  }
}

function extractImageUrl($: cheerio.CheerioAPI, pageUrl: string): string | null {
  const meta =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[name="twitter:image:src"]').attr('content') ||
    $('link[rel="image_src"]').attr('href');
  if (meta) return absolutize(meta, pageUrl);

  // JSON-LD schema.org
  let fromSchema: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (fromSchema) return;
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of candidates) {
        if (!node) continue;
        const img = node.image ?? node['@graph']?.find((n: { image?: unknown }) => n.image)?.image;
        if (!img) continue;
        if (typeof img === 'string') {
          fromSchema = img;
          return;
        }
        if (Array.isArray(img) && typeof img[0] === 'string') {
          fromSchema = img[0];
          return;
        }
        if (typeof img === 'object' && (img.url || img.contentUrl)) {
          fromSchema = img.url ?? img.contentUrl;
          return;
        }
      }
    } catch {
      /* ignore */
    }
  });
  if (fromSchema) return absolutize(fromSchema, pageUrl);

  // Heuristic: largest visible image inside <article>/<body>
  const container = $('article').length ? $('article') : $('body');
  let best: string | null = null;
  container.find('img').each((_, el) => {
    if (best) return;
    const $img = $(el);
    const src = $img.attr('src') ?? $img.attr('data-src') ?? $img.attr('data-lazy-src');
    if (!src || src.length < 6) return;
    if (/logo|icon|sprite|tracker|pixel/i.test(src)) return;
    const w = Number($img.attr('width') ?? '0');
    const h = Number($img.attr('height') ?? '0');
    if (w >= 200 || h >= 200 || (!w && !h)) {
      best = absolutize(src, pageUrl);
    }
  });
  return best;
}

function extractPublishedAt(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): string | null {
  const fromMeta =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[itemprop="datePublished"]').attr('content') ||
    $('meta[name="date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime');
  if (fromMeta) return fromMeta;

  // JSON-LD
  let fromSchema: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (fromSchema) return;
    try {
      const raw = $(el).html();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of candidates) {
        if (!node) continue;
        const direct = node.datePublished ?? node.dateCreated ?? node.dateModified;
        if (direct) {
          fromSchema = direct;
          return;
        }
        const graph = node['@graph'];
        if (Array.isArray(graph)) {
          for (const g of graph) {
            const d = g?.datePublished ?? g?.dateCreated ?? g?.dateModified;
            if (d) {
              fromSchema = d;
              return;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  });
  if (fromSchema) return fromSchema;

  // URL pattern /YYYY/MM/DD/
  const urlMatch = pageUrl.match(/\/(\d{4})[/-](\d{2})[/-](\d{2})/);
  if (urlMatch) {
    return `${urlMatch[1]}-${urlMatch[2]}-${urlMatch[3]}T00:00:00Z`;
  }

  // dd.mm.yyyy in common date containers (Montevideo Portal etc.)
  const txt = $('.fecha, .date, .time, .published').first().text();
  const m = txt.match(/(\d{2})[./-](\d{2})[./-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T00:00:00Z`;

  return null;
}

function extractContent($: cheerio.CheerioAPI): string {
  // Find the candidate container with the most paragraph text — works
  // surprisingly well for news templates without site-specific selectors.
  const candidates = $(
    'article, main, .content, #content, .post-content, .entry-content, body',
  );
  let bestLen = 0;
  let bestText = '';
  candidates.each((_, el) => {
    const $el = $(el);
    const paras = $el
      .find('p')
      .map((__, p) => $(p).text().trim())
      .get();
    const txt = paras.filter((t) => t.length > 20).join('\n\n');
    if (txt.length > bestLen) {
      bestLen = txt.length;
      bestText = txt;
    }
  });

  let content = bestText;
  if (content.length < 50) {
    content = $('p')
      .map((__, p) => $(p).text().trim())
      .get()
      .filter((t) => t.length > 25)
      .join('\n\n');
  }

  if (content.length > 20000) {
    content = content.slice(0, 20000) + '...';
  }
  return content;
}

export interface ExtractResult {
  ok: true;
  article: ScrapedArticle;
}

export interface ExtractFailure {
  ok: false;
  reason: 'fetch_failed' | 'no_headline' | 'no_content' | 'no_date' | 'invalid_date' | 'too_old';
  message?: string;
}

export async function extractArticle(
  url: string,
  domain: string,
): Promise<ExtractResult | ExtractFailure> {
  let html: string;
  try {
    const res = await axios.get(url, {
      headers: BROWSER_HEADERS,
      httpsAgent,
      timeout: 15_000,
      maxRedirects: 5,
      decompress: true,
    });
    html = res.data as string;
  } catch (err) {
    return { ok: false, reason: 'fetch_failed', message: (err as Error).message };
  }

  const $ = cheerio.load(html);

  const headline =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('h1').first().text().trim();
  if (!headline) return { ok: false, reason: 'no_headline' };

  const content = extractContent($);
  if (content.length < 50) return { ok: false, reason: 'no_content' };

  const rawDate = extractPublishedAt($, url);
  if (!rawDate) return { ok: false, reason: 'no_date' };
  const published = new Date(rawDate);
  if (Number.isNaN(published.getTime())) {
    return { ok: false, reason: 'invalid_date', message: rawDate };
  }
  const ageDays = (Date.now() - published.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > FRESHNESS_DAYS) return { ok: false, reason: 'too_old' };

  return {
    ok: true,
    article: {
      url,
      domain,
      headline,
      content,
      imageUrl: extractImageUrl($, url),
      publishedAt: published.toISOString(),
    },
  };
}
