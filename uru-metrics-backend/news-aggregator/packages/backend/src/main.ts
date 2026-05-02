// Combined production entrypoint for the HA addon: boots the Hono HTTP API
// AND schedules the hourly ingest cron in a single Node process. The server
// imports do their own top-level work (serve(...) on Hono); we explicitly
// kick off the cron after that so the first tick runs immediately on boot.
import './server.js';
import { start as startCron, tick } from './jobs/hourly.js';

startCron();
void tick();
