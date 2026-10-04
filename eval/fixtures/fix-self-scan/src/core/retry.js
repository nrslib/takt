// Deterministic retry planner: fixed base delay with linear backoff.
export function planRetries(attempts, baseDelayMs) {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`attempts must be a non-negative integer: ${attempts}`);
  }
  const plan = [];
  for (let i = 0; i < attempts; i += 1) {
    plan.push(baseDelayMs * (i + 1));
  }
  return plan;
}
