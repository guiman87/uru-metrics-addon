import type { Source } from '@uru/shared';

// 13 Uruguay news sources. `active` flips on/off without a code change once
// the migration syncs this file into the DB.
//
// Phase 1: only the first 3 are active to keep crawl cycles short while the
// pipeline matures. Flip the rest to `active: true` once stable.
export const sources: Array<Omit<Source, 'lastCrawledAt'>> = [
  {
    domain: 'elpais.com.uy',
    displayName: 'El País',
    seedUrls: ['https://www.elpais.com.uy/'],
    weight: 1.0,
    biasLabel: 'right',
    paywalled: false,
    active: true,
    fetcher: 'cheerio',
  },
  {
    domain: 'elobservador.com.uy',
    displayName: 'El Observador',
    seedUrls: ['https://www.elobservador.com.uy/'],
    weight: 1.0,
    biasLabel: 'center',
    paywalled: false,
    active: true,
    fetcher: 'cheerio',
  },
  {
    domain: 'montevideo.com.uy',
    displayName: 'Montevideo Portal',
    seedUrls: ['https://www.montevideo.com.uy/'],
    weight: 1.0,
    biasLabel: 'center',
    paywalled: false,
    active: true,
    fetcher: 'cheerio',
  },

  // ─── Inactive in Phase 1, ready to flip on ───────────────────────────────
  {
    domain: 'ladiaria.com.uy',
    displayName: 'la diaria',
    seedUrls: ['https://ladiaria.com.uy/'],
    weight: 1.0,
    biasLabel: 'left',
    paywalled: true,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'subrayado.com.uy',
    displayName: 'Subrayado',
    seedUrls: ['https://www.subrayado.com.uy/'],
    weight: 1.0,
    biasLabel: 'center',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'teledoce.com',
    displayName: 'Teledoce',
    seedUrls: ['https://www.teledoce.com/'],
    weight: 1.0,
    biasLabel: 'center',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'canal10.com.uy',
    displayName: 'Canal 10',
    seedUrls: ['https://www.canal10.com.uy/'],
    weight: 1.0,
    biasLabel: 'center',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'republica.com.uy',
    displayName: 'La República',
    seedUrls: ['https://www.republica.com.uy/'],
    weight: 1.0,
    biasLabel: 'left',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'brecha.com.uy',
    displayName: 'Brecha',
    seedUrls: ['https://brecha.com.uy/'],
    weight: 1.0,
    biasLabel: 'left',
    paywalled: true,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: '180.com.uy',
    displayName: '180',
    seedUrls: ['https://www.180.com.uy/'],
    weight: 1.0,
    biasLabel: 'left',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'carasycaretas.com.uy',
    displayName: 'Caras y Caretas',
    seedUrls: ['https://www.carasycaretas.com.uy/'],
    weight: 1.0,
    biasLabel: 'left',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'cronicas.com.uy',
    displayName: 'Crónicas',
    seedUrls: ['https://www.cronicas.com.uy/'],
    weight: 1.0,
    biasLabel: 'right',
    paywalled: false,
    active: false,
    fetcher: 'cheerio',
  },
  {
    domain: 'busqueda.com.uy',
    displayName: 'Búsqueda',
    seedUrls: ['https://www.busqueda.com.uy/'],
    weight: 0.8, // paywalled — lower weight until full content is reachable
    biasLabel: 'center',
    paywalled: true,
    active: false,
    fetcher: 'cheerio',
  },
];

export function getActiveSources(): Array<Omit<Source, 'lastCrawledAt'>> {
  return sources.filter((s) => s.active);
}
