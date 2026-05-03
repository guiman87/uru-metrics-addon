// Phase 2 CLI: candidate scan for entity-evergreen promotion. Thin wrapper
// around scanEntities() in src/ai/promote-entities.ts so the same code path
// runs from CLI, the admin HTTP endpoint, and the cron auto-promoter.
//
// Writes the result to a JSON file the operator can review/edit before
// running `npm run promote:apply`. Pure SQL, no LLM cost.

import fs from 'node:fs';
import path from 'node:path';
import { closeDb } from '../src/db/client.js';
import { config } from '../src/config.js';
import { scanEntities } from '../src/ai/promote-entities.js';

interface CliArgs {
  daysBack: number;
  minMentions: number;
  minSources: number;
  top: number;
  output: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i === -1) return fallback;
    const a = args[i] ?? '';
    if (a.includes('=')) return a.split('=')[1] ?? fallback;
    return args[i + 1] ?? fallback;
  };
  return {
    daysBack: Number(get('--days', '90')),
    minMentions: Number(get('--min-mentions', '20')),
    minSources: Number(get('--min-sources', '4')),
    top: Number(get('--top', '50')),
    output: get(
      '--output',
      path.join(path.dirname(config.dbPath), 'entity-promotion-candidates.json'),
    ),
  };
}

function main(): void {
  const opts = parseArgs();
  console.log(
    `[scan-entities] days=${opts.daysBack} min-mentions=${opts.minMentions} min-sources=${opts.minSources} top=${opts.top}`,
  );
  console.log(`[scan-entities] output=${opts.output}`);

  const candidates = scanEntities({
    daysBack: opts.daysBack,
    minMentions: opts.minMentions,
    minSources: opts.minSources,
    top: opts.top,
  });

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    params: {
      daysBack: opts.daysBack,
      minMentions: opts.minMentions,
      minSources: opts.minSources,
    },
    candidateCount: candidates.length,
    candidates,
  };
  // Atomic write: tmp + rename so a partial file never confuses apply.
  const tmp = `${opts.output}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, opts.output);

  console.log(
    `[scan-entities] Wrote ${candidates.length} candidates to ${opts.output}`,
  );
  if (candidates.length > 0) {
    console.log('[scan-entities] Top 10:');
    for (const c of candidates.slice(0, 10)) {
      console.log(
        `  - ${c.candidateLabel.padEnd(40)} ${String(c.mentionCount).padStart(4)}m / ${String(c.sourceCount).padStart(2)}s`,
      );
    }
  }

  closeDb();
}

main();
