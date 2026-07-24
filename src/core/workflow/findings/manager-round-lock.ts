import type { FindingManagerStore } from './store.js';
import { runLedgerRoundExclusive } from './ledger-identity-queue.js';

export async function runManagerRoundExclusive<Result>(
  store: FindingManagerStore,
  action: () => Promise<Result>,
): Promise<Result> {
  return runLedgerRoundExclusive(store.ledgerIdentity, action);
}
