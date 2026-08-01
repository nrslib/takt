import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunPaths } from '../../src/core/workflow/run/run-paths.js';
import type { FindingLedger } from '../../src/core/workflow/findings/types.js';
import { FindingDatabase } from '../../src/infra/finding-storage/database.js';
import { readSourceAuthority } from '../../src/infra/finding-storage/repository.js';
import { ROOT_FINDING_AUTHORITY_KEY } from '../../src/infra/finding-storage/resolver.js';

export function readOnlyRunFindingLedger(repoPath: string): FindingLedger {
  const runsDir = join(repoPath, '.takt', 'runs');
  const runSlugs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (runSlugs.length !== 1 || runSlugs[0] === undefined) {
    throw new Error(`Expected one run directory, got ${runSlugs.length}`);
  }
  const runSlug = runSlugs[0];
  const databasePath = buildRunPaths(repoPath, runSlug).findingContractDatabaseAbs;
  if (!existsSync(databasePath)) {
    throw new Error(`Finding Contract database is missing for run "${runSlug}"`);
  }
  const ledger = FindingDatabase.readSource({
    databasePath,
    runId: runSlug,
    read: (database) => readSourceAuthority(database, ROOT_FINDING_AUTHORITY_KEY),
  });
  if (ledger === undefined) {
    throw new Error(`Root Finding Contract authority is missing for run "${runSlug}"`);
  }
  return ledger;
}
