import type { RunResult } from './run-result.js';
import { publishTerminalSummary } from './terminal-summary.js';

export function dispatchRunResult(result: RunResult): void {
  if (result.status === 'completed') {
    publishTerminalSummary(result);
    return;
  }

  if (result.status === 'failed') {
    return;
  }

  return;
}
