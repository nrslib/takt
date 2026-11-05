import { parentPort, workerData } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseRunProgress } from './runProgress.js';
import { isMissing } from './files.js';

const port = parentPort;
if (port === null) throw new Error('Run progress reader requires a worker port');
try {
  const file = await open(workerData as string, constants.O_RDONLY | constants.O_NONBLOCK);
  let text;
  try {
    if (!(await file.stat()).isFile()) throw new Error('Run metadata is not regular');
    text = await file.readFile('utf8');
  } finally { await file.close(); }
  port.postMessage({ ok: true, progress: parseRunProgress(JSON.parse(text) as unknown) });
} catch (error) {
  port.postMessage(isMissing(error) ? { ok: true, progress: undefined }
    : { ok: false, message: error instanceof Error ? error.message : String(error) });
}
