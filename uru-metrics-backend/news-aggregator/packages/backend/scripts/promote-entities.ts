// Phase 2: CLI wrapper that turns reviewed scan-entities candidates into
// real entity-evergreen topics via the LLM promotion pipeline.
//
// Usage (defaults match scan-entities.ts output path):
//   npm run promote:apply
//   npm run promote:apply -- --input=/data/entity-promotion-candidates.json
//   npm run promote:apply -- --dry-run            # parse + validate, no insert
//   npm run promote:apply -- --limit=10           # only first N candidates

import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../src/db/client.js';
import { config } from '../src/config.js';
import { getProvider } from '../src/ai/provider.js';
import {
  promoteEntities,
  type ScanCandidate,
} from '../src/ai/promote-entities.js';

interface CliArgs {
  input: string;
  limit: number;
  dryRun: boolean;
  providerName: string;
  model: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i === -1) return null;
    const a = args[i] ?? '';
    if (a.includes('=')) return a.split('=')[1] ?? '';
    return args[i + 1] ?? '';
  };
  const has = (name: string): boolean => args.includes(name);
  return {
    input:
      flag('--input') ??
      path.join(path.dirname(config.dbPath), 'entity-promotion-candidates.json'),
    limit: Number(flag('--limit') ?? '0'), // 0 = no limit
    dryRun: has('--dry-run'),
    providerName: flag('--provider') ?? config.llm.provider,
    model: flag('--model') ?? config.llm.modelCategorize,
  };
}

interface CandidatesFile {
  generatedAt: string;
  candidateCount: number;
  candidates: ScanCandidate[];
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!fs.existsSync(opts.input)) {
    console.error(
      `[promote] No candidates file at ${opts.input}. Run \`npm run promote:scan\` first.`,
    );
    process.exit(2);
  }
  const raw = fs.readFileSync(opts.input, 'utf-8');
  const parsed = JSON.parse(raw) as CandidatesFile;
  let candidates = parsed.candidates;
  if (opts.limit > 0) candidates = candidates.slice(0, opts.limit);

  console.log(
    `[promote] input=${opts.input} candidates=${candidates.length}/${parsed.candidates.length} provider=${opts.providerName} model=${opts.model} dry-run=${opts.dryRun}`,
  );

  if (opts.dryRun) {
    console.log('[promote] Dry run — would consider these candidates:');
    for (const c of candidates) {
      console.log(
        `  - ${c.candidateLabel.padEnd(40)} ${String(c.mentionCount).padStart(4)}m / ${String(c.sourceCount).padStart(2)}s`,
      );
    }
    closeDb();
    return;
  }

  const provider = getProvider(opts.providerName);
  const stats = await promoteEntities({
    candidates,
    provider,
    model: opts.model,
  });

  console.log('[promote] Done.');
  console.log(
    `  considered=${stats.considered} inserted=${stats.inserted} excluded=${stats.skippedExcluded} duplicate=${stats.skippedDuplicate} bad-parent=${stats.skippedBadParent} failed=${stats.failed}`,
  );
  closeDb();
}

main().catch((err) => {
  console.error('[promote] fatal:', err);
  process.exit(1);
});
