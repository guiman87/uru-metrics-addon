import { runIngest } from '../ingest/pipeline.js';
import { closeDb } from '../db/client.js';

function parseArgs(): { skipAi: boolean; providerName?: string } {
  const args = new Set(process.argv.slice(2));
  const out: { skipAi: boolean; providerName?: string } = { skipAi: args.has('--no-ai') };
  for (const a of args) {
    const m = a.match(/^--provider=(.+)$/);
    if (m) out.providerName = m[1];
  }
  return out;
}

async function main(): Promise<void> {
  const { skipAi, providerName } = parseArgs();
  console.log(`[run-once] Starting one-shot ingest (skipAi=${skipAi}, provider=${providerName ?? 'default'})...`);
  const result = await runIngest({ skipAi, providerName });
  console.log(
    `[run-once] Done in ${result.durationMs}ms — inserted ${result.totalInserted} new articles, ai=${JSON.stringify(result.ai)}.`,
  );
  closeDb();
}

main().catch((err) => {
  console.error('[run-once] Failed:', err);
  closeDb();
  process.exit(1);
});
