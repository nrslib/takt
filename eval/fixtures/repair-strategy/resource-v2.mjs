export async function run(pool, body, signal) {
  const lease = pool.acquire();
  if (signal.aborted) return { status: 'cancelled' };
  try {
    const value = await body(lease);
    lease.release();
    return { status: 'ok', value };
  } catch (error) {
    lease.release();
    throw error;
  }
}
