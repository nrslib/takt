const roundQueues = new Map<string, Promise<void>>();
const updateQueues = new Map<string, Promise<void>>();

async function runExclusive<Result>(
  queues: Map<string, Promise<void>>,
  ledgerIdentity: string,
  action: () => Promise<Result> | Result,
): Promise<Result> {
  const preceding = queues.get(ledgerIdentity) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = preceding.then(() => gate);
  queues.set(ledgerIdentity, queued);
  await preceding;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(ledgerIdentity) === queued) {
      queues.delete(ledgerIdentity);
    }
  }
}

export function runLedgerRoundExclusive<Result>(
  ledgerIdentity: string,
  action: () => Promise<Result>,
): Promise<Result> {
  return runExclusive(roundQueues, ledgerIdentity, action);
}

export function runLedgerUpdateExclusive<Result>(
  ledgerIdentity: string,
  action: () => Result,
): Promise<Result> {
  return runExclusive(updateQueues, ledgerIdentity, action);
}
