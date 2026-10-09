type Cleanup = () => Promise<void>;

const pendingCleanups = new Set<Cleanup>();

export function registerModelSelectionSessionCleanup(cleanup: Cleanup): () => void {
  pendingCleanups.add(cleanup);
  return () => pendingCleanups.delete(cleanup);
}

export async function cleanupPendingModelSelectionSessions(): Promise<void> {
  const results = await Promise.allSettled([...pendingCleanups].map((cleanup) => cleanup()));
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clean up OpenCode model-selection sessions');
  }
}
