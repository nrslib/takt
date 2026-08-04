import { planRetries } from '../core/retry.js';

// Polls the queue state with a bounded retry plan.
export function buildWatchPlan(pollAttempts, pollDelayMs) {
  const delays = planRetries(pollAttempts, pollDelayMs);
  return { delays, total: delays.reduce((sum, d) => sum + d, 0) };
}
