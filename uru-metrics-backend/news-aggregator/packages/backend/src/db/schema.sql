-- uru-metrics / news-aggregator schema
-- Apply via src/db/migrate.ts. Idempotent: every CREATE uses IF NOT EXISTS.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS sources (
  domain          TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  seed_urls       TEXT NOT NULL,            -- JSON array
  weight          REAL NOT NULL DEFAULT 1.0,
  bias_label      TEXT,                     -- 'left'|'center'|'right'|null
  paywalled       INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  fetcher         TEXT NOT NULL DEFAULT 'cheerio', -- 'cheerio'|'playwright'
  last_crawled_at TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT UNIQUE NOT NULL,
  url_canonical   TEXT,
  domain          TEXT NOT NULL REFERENCES sources(domain),
  headline        TEXT NOT NULL,
  summary         TEXT,                     -- LLM-generated, <=400 chars
  content         TEXT,
  image_url       TEXT,
  published_at    TEXT NOT NULL,            -- ISO-8601 UTC
  scraped_at      TEXT NOT NULL,
  lang            TEXT NOT NULL DEFAULT 'es',
  entities_json   TEXT,
  keywords_json   TEXT,
  embedding       BLOB,                     -- optional, phase 2.5
  status          TEXT NOT NULL DEFAULT 'new'   -- 'new'|'categorized'|'failed'
);
CREATE INDEX IF NOT EXISTS idx_articles_pub        ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_domain_pub ON articles(domain, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles(status);

CREATE TABLE IF NOT EXISTS topics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT UNIQUE NOT NULL,
  label           TEXT NOT NULL,
  description     TEXT,
  keywords_json   TEXT NOT NULL,
  centroid        BLOB,
  parent_topic_id INTEGER REFERENCES topics(id),
  scope           TEXT NOT NULL DEFAULT 'story',  -- 'evergreen'|'event'|'story'
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active', -- 'active'|'merged'|'archived'
  -- For evergreens promoted from frequently-mentioned entities
  -- (Peñarol, Frente Amplio, Lacalle Pou, ANTEL, etc.). NULL for the
  -- 12 seeded vertical evergreens. Lets the UI style entity pages
  -- differently and lets the cluster step know which evergreens to
  -- match articles against by entity name.
  entity_type     TEXT                            -- 'person'|'party'|'org'|'team'|'place'|null
);
CREATE INDEX IF NOT EXISTS idx_topics_last_seen ON topics(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_topics_parent    ON topics(parent_topic_id);
CREATE INDEX IF NOT EXISTS idx_topics_scope     ON topics(scope);

CREATE TABLE IF NOT EXISTS article_topics (
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  topic_id    INTEGER NOT NULL REFERENCES topics(id)   ON DELETE CASCADE,
  confidence  REAL NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_at_topic ON article_topics(topic_id);

CREATE TABLE IF NOT EXISTS topic_scores (
  topic_id        INTEGER NOT NULL REFERENCES topics(id),
  computed_at     TEXT NOT NULL,
  window_hours    INTEGER NOT NULL DEFAULT 24,
  source_count    INTEGER NOT NULL,
  article_count   INTEGER NOT NULL,
  recency_score   REAL NOT NULL,
  salience_score  REAL NOT NULL,
  importance      REAL NOT NULL,
  PRIMARY KEY (topic_id, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_topic_scores_computed ON topic_scores(computed_at DESC);

CREATE TABLE IF NOT EXISTS topic_snapshots (
  date           TEXT NOT NULL,             -- 'YYYY-MM-DD' UY local
  topic_id       INTEGER NOT NULL,
  domain         TEXT NOT NULL,
  article_count  INTEGER NOT NULL,
  PRIMARY KEY (date, topic_id, domain)
);

CREATE TABLE IF NOT EXISTS topic_aliases (
  alias    TEXT PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS llm_usage (
  ts                       TEXT NOT NULL,
  provider                 TEXT NOT NULL,
  model                    TEXT NOT NULL,
  input_tok                INTEGER NOT NULL,        -- uncached input tokens
  output_tok               INTEGER NOT NULL,
  cache_creation_input_tok INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tok     INTEGER NOT NULL DEFAULT 0,
  cost_usd                 REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts);

-- Bookkeeping for cron observability.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,              -- 'running'|'ok'|'error'
  articles_new  INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

-- ─── Full-text search (FTS5) ──────────────────────────────────────────────
-- External-content table over `articles` — the FTS index doesn't duplicate
-- raw text on disk; the triggers below keep it in sync. Column names must
-- match `articles` exactly because FTS5's external-content reader pulls
-- by column name.
--
-- Tokenizer:
--   unicode61 strips punctuation, lowercases.
--   remove_diacritics 2 normalizes Spanish accents so "futbol" matches
--     "fútbol" and "Lacalle Pou" matches "lacalle-pou".
--
-- Indexed columns: headline + summary + entities_json + content. content
-- carries the largest payload but offers the best recall for body-text
-- queries. NULL-valued columns are coalesced to '' in the triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  headline,
  summary,
  entities_json,
  content,
  content='articles',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Sync triggers. SQLite's `IF NOT EXISTS` is honored on CREATE TRIGGER, so
-- replays of schema.sql are safe.
CREATE TRIGGER IF NOT EXISTS articles_fts_ai
AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, headline, summary, entities_json, content)
  VALUES (
    new.id,
    new.headline,
    COALESCE(new.summary, ''),
    COALESCE(new.entities_json, ''),
    COALESCE(new.content, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_ad
AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, headline, summary, entities_json, content)
  VALUES (
    'delete',
    old.id,
    old.headline,
    COALESCE(old.summary, ''),
    COALESCE(old.entities_json, ''),
    COALESCE(old.content, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_au
AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, headline, summary, entities_json, content)
  VALUES (
    'delete',
    old.id,
    old.headline,
    COALESCE(old.summary, ''),
    COALESCE(old.entities_json, ''),
    COALESCE(old.content, '')
  );
  INSERT INTO articles_fts(rowid, headline, summary, entities_json, content)
  VALUES (
    new.id,
    new.headline,
    COALESCE(new.summary, ''),
    COALESCE(new.entities_json, ''),
    COALESCE(new.content, '')
  );
END;
