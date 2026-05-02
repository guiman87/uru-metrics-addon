import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config } from './config.js';
import { healthRoute } from './api/health.js';
import { articlesRoute } from './api/articles.js';
import { sourcesRoute } from './api/sources.js';
import { topicsRoute } from './api/topics.js';

const app = new Hono();

app.use('*', logger());
app.use(
  '/api/*',
  cors({
    origin: config.corsOrigins,
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  }),
);

app.get('/', (c) => c.text('uru-metrics / news-aggregator API\n'));

app.route('/api/health', healthRoute);
app.route('/api/articles', articlesRoute);
app.route('/api/sources', sourcesRoute);
app.route('/api/topics', topicsRoute);

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(`[server] Listening on http://${info.address}:${info.port}`);
  },
);

const shutdown = (signal: string) => {
  console.log(`[server] ${signal} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
