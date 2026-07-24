import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFindingLedgerStore } from '../../core/workflow/findings/store.js';

const [projectCwd, workerId, readyPath, releasePath] = process.argv.slice(2);
if (projectCwd === undefined
  || workerId === undefined
  || readyPath === undefined
  || releasePath === undefined) {
  throw new Error('finding-ledger concurrent update fixture arguments are missing');
}

const reportDir = join(projectCwd, '.takt', 'runs', `worker-${workerId}`, 'reports');
mkdirSync(reportDir, { recursive: true });
const store = createFindingLedgerStore({
  projectCwd,
  reportDir,
  workflowName: 'peer-review',
  ledgerPath: '.takt/findings/peer-review.json',
  rawFindingsPath: '.takt/findings/raw',
});

writeFileSync(readyPath, 'ready', 'utf-8');
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releasePath)) {
  Atomics.wait(waitBuffer, 0, 0, 10);
}

async function increment(): Promise<void> {
  await store.updateLedger((current) => {
    return {
      ledger: { ...current, nextId: current.nextId + 1 },
      result: undefined,
    };
  });
}

try {
  await increment();
} catch {
  await increment();
}
