import { randomBytes } from 'node:crypto';

let lastRunIdTimestamp = '';
let runIdSequence = 0;

export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, len: number): string => String(n).padStart(len, '0');
  const timestamp = `run-${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}-${pad(now.getMilliseconds(), 3)}`;

  if (timestamp === lastRunIdTimestamp) {
    runIdSequence += 1;
  } else {
    lastRunIdTimestamp = timestamp;
    runIdSequence = 0;
  }

  const randomSuffix = randomBytes(4).toString('hex');
  return `${timestamp}-${pad(runIdSequence, 3)}-${randomSuffix}`;
}
