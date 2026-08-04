import { FindingStorageResolver } from '../../infra/finding-storage/index.js';

const [, , databasePath, reportDir] = process.argv;
if (databasePath === undefined || reportDir === undefined) {
  throw new Error('Finding storage process fixture requires database and report paths');
}

process.stdout.write('ready\n');
process.stdin.once('data', () => {
  const resolver = new FindingStorageResolver({
    databasePath,
    runId: 'concurrent-run',
  });
  const store = resolver.resolveAuthority({
    authorityKey: 'root',
    workflowName: 'concurrent-workflow',
    reportDir,
  });
  process.stdout.write(`${JSON.stringify({
    ledgerIdentity: store.ledgerIdentity,
    ledger: store.loadLedger(),
  })}\n`);
  resolver.close();
});
