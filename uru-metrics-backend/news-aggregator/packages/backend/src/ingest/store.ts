import { getDb } from '../db/client.js';
import type { ScrapedArticle } from '@uru/shared';

export interface StoreStats {
  inserted: number;
  duplicates: number;
}

export function getKnownUrlsForDomain(domain: string): Set<string> {
  const rows = getDb()
    .prepare<[string], { url: string }>('SELECT url FROM articles WHERE domain = ?')
    .all(domain);
  return new Set(rows.map((r) => r.url));
}

export function storeArticles(articles: ScrapedArticle[]): StoreStats {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO articles (
      url, domain, headline, content, image_url, published_at, scraped_at, status
    ) VALUES (
      @url, @domain, @headline, @content, @imageUrl, @publishedAt, @scrapedAt, 'new'
    )
  `);

  let inserted = 0;
  let duplicates = 0;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const a of articles) {
      const result = insert.run({
        url: a.url,
        domain: a.domain,
        headline: a.headline,
        content: a.content,
        imageUrl: a.imageUrl,
        publishedAt: a.publishedAt,
        scrapedAt: now,
      });
      if (result.changes > 0) inserted += 1;
      else duplicates += 1;
    }
  });
  tx();
  return { inserted, duplicates };
}

export function touchSourceCrawledAt(domain: string): void {
  getDb()
    .prepare('UPDATE sources SET last_crawled_at = ? WHERE domain = ?')
    .run(new Date().toISOString(), domain);
}
