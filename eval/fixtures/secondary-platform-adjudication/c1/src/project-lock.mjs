import { readFileSync, writeFileSync } from 'node:fs';
import { getProcessStartTime, isSameProcess } from './process-start.mjs';

function isValidStartTime(startedAt) {
  return (typeof startedAt === 'string' && startedAt.length > 0)
    || (typeof startedAt === 'number'
      && Number.isFinite(startedAt) && startedAt > 0);
}

export function recordLockOwner(path, pid = process.pid, readers) {
  const startedAt = getProcessStartTime(pid, readers);
  if (!isValidStartTime(startedAt)) throw new Error('process start time unavailable');
  const owner = { pid, startedAt };
  writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
  return owner;
}

export function restoreLockOwner(path) {
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1
    || !isValidStartTime(owner.startedAt)) {
    throw new Error('invalid lock owner');
  }
  return owner;
}

export function isCurrentProcessLockOwner(path, currentPid = process.pid, readers) {
  return isSameProcess(restoreLockOwner(path), currentPid, readers);
}

export function beginProjectRun(path, currentPid = process.pid, readers) {
  try {
    return { state: 'acquired', owner: recordLockOwner(path, currentPid, readers) };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = restoreLockOwner(path);
    return {
      state: isSameProcess(owner, currentPid, readers) ? 'owned' : 'busy',
      owner,
    };
  }
}
