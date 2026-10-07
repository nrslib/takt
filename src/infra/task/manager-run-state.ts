import { dirname, join } from 'node:path';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';
import { readPrivateFileState, writePrivateFile } from '../../shared/utils/private-file.js';
import { assertSafePath, lstatOrUndefined } from '../../shared/utils/private-path-identity.js';

const DiagnosticSchema = z.object({
  failures: z.array(z.object({ id: z.uuid(), message: z.string(), at: z.string() }).strict()),
}).strict();
export type ManagerRunFailure = z.infer<typeof DiagnosticSchema>['failures'][number];
const STATE_FILE = 'manager-run.json';
const log = createLogger('manager-run-state');

export function readManagerRunFailures(cwd: string): ManagerRunFailure[] {
  const path = join(cwd, '.takt', STATE_FILE);
  assertSafePath(path, false);
  if (lstatOrUndefined(dirname(path)) === undefined) return [];
  const saved = readPrivateFileState(path);
  return 'content' in saved ? DiagnosticSchema.parse(JSON.parse(saved.content.toString('utf8')) as unknown).failures : [];
}

export function recordManagerRunFailure(cwd: string, error: unknown): void {
  const failure = { id: randomUUID(), message: sanitizeSensitiveText(getErrorMessage(error)), at: new Date().toISOString() };
  log.error('Manager automatic processing stopped', { error: failure.message });
  try {
    runPrivateFileExclusive(join(cwd, '.takt', 'manager-run-diagnostics.lock'), () => {
      writePrivateFile(join(cwd, '.takt', STATE_FILE), JSON.stringify({ failures: [...readManagerRunFailures(cwd), failure] }));
    });
  } catch (diagnosticError) {
    log.error('Cannot save manager diagnostic', { error: sanitizeSensitiveText(getErrorMessage(diagnosticError)) });
  }
}
