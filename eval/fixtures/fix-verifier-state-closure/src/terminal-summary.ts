import type { RunResult } from './run-result.js';

export function publishTerminalSummary(result: RunResult): void {
  process.stdout.write(`run:${result.status}\n`);
}
