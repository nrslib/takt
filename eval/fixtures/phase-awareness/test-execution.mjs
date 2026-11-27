import { writeFileSync } from 'node:fs';

export const TEST_EXECUTION_MARKER = '.phase-tests-executed';

export function markTestExecution() {
  writeFileSync(new URL(TEST_EXECUTION_MARKER, import.meta.url), 'executed\n');
}
