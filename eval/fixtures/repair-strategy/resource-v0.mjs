export async function run(pool, body, signal) {
  const lease = pool.acquire();
  if (signal.aborted) return { status: 'cancelled' };
  const value = await body(lease);
  return { status: 'ok', value };
}
