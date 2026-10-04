import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const runtimePath = process.env.TAKT_DSH_PROBE_DSH_BIN
  ?? process.env.TAKT_DSH_PROBE_RUNTIME_PATH;
const pgidFile = process.env.TAKT_DSH_PROBE_PGID_FILE;
const supervisorPidFile = process.env.TAKT_DSH_PROBE_SUPERVISOR_PID_FILE;
const ownerRecordFile = process.env.TAKT_DSH_PROBE_OWNER_RECORD_FILE;
const spawnLog = process.env.TAKT_DSH_PROBE_SPAWN_LOG;
const cleanMarker = process.env.TAKT_DSH_PROBE_CLEAN_MARKER;
const failCleanup = process.env.TAKT_DSH_PROBE_FAIL_CLEANUP === '1';

if (runtimePath === undefined) process.exit(72);

/** Check for live non-zombie members of the fixture group and fail closed on uncertain process probes. */
function processGroupHasLiveMembers(pgid) {
  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
    if (result.error === undefined && result.status === 0) {
      return result.stdout.split('\n').some((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/u);
        return match !== null && Number(match[1]) === pgid && !match[2].startsWith('Z');
      });
    }
  }
  try {
    process.kill(process.platform === 'win32' ? pgid : -pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

for (const filePath of [ownerRecordFile, spawnLog, supervisorPidFile, pgidFile]) {
  if (filePath !== undefined) mkdirSync(dirname(filePath), { recursive: true });
}

if (ownerRecordFile !== undefined && existsSync(ownerRecordFile)) {
  const previousPgid = Number(readFileSync(ownerRecordFile, 'utf8'));
  if (processGroupHasLiveMembers(previousPgid)) process.exit(73);
  unlinkSync(ownerRecordFile);
}

if (supervisorPidFile !== undefined) writeFileSync(supervisorPidFile, String(process.pid), 'utf8');
if (spawnLog !== undefined) appendFileSync(spawnLog, `${process.pid}\n`, 'utf8');

const runtime = spawn(process.execPath, [runtimePath, ...process.argv.slice(2)], {
  detached: process.platform !== 'win32',
  env: process.env,
  stdio: ['pipe', 'pipe', 'ignore'],
});

if (runtime.pid !== undefined && pgidFile !== undefined) {
  writeFileSync(pgidFile, String(runtime.pid), 'utf8');
}
if (runtime.pid !== undefined && ownerRecordFile !== undefined) {
  writeFileSync(ownerRecordFile, String(runtime.pid), 'utf8');
}

let stopping;
let runtimeExit;
runtime.once('exit', () => {
  runtimeExit = true;
  if (stopping === undefined) void stopOwnedTree();
});
runtime.once('error', () => {
  runtimeExit = true;
});

process.stdin.pipe(runtime.stdin);
runtime.stdout.pipe(process.stdout);

/** Signal the owned fixture group, ignoring only an already-disappeared process. */
function signalGroup(signal) {
  if (runtime.pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? runtime.pid : -runtime.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/** Report whether the fixture runtime still has live group members. */
function groupExists() {
  if (runtime.pid === undefined) return false;
  return processGroupHasLiveMembers(runtime.pid);
}

/** Wait for the direct runtime child to exit without mistaking a group check for child reaping. */
async function waitForRuntimeExit(timeoutMs) {
  if (runtimeExit === true || runtime.exitCode !== null || runtime.signalCode !== null) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtimeExit === true || runtime.exitCode !== null || runtime.signalCode !== null) return true;
    await delay(10);
  }
  return false;
}

/** Wait for all fixture group members to disappear and return the final state at the deadline. */
async function waitForGroupGone(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists()) return true;
    await delay(10);
  }
  return !groupExists();
}

/** Stop the owned fixture tree once, escalating TERM to KILL and reporting unconfirmed group cleanup. */
function stopOwnedTree() {
  if (stopping !== undefined) return stopping;
  stopping = (async () => {
    if (failCleanup) return;

    signalGroup('SIGTERM');
    if (!(await waitForRuntimeExit(80))) {
      signalGroup('SIGKILL');
      await waitForRuntimeExit(500);
    }

    if (!(await waitForGroupGone(500))) signalGroup('SIGKILL');
    const groupGone = await waitForGroupGone(500);
    if (groupGone) {
      if (cleanMarker !== undefined) writeFileSync(cleanMarker, 'clean', 'utf8');
      if (ownerRecordFile !== undefined && existsSync(ownerRecordFile)) {
        const recordedPgid = Number(readFileSync(ownerRecordFile, 'utf8'));
        if (recordedPgid === runtime.pid) unlinkSync(ownerRecordFile);
      }
    }
    process.exitCode = groupGone ? 0 : 73;
  })();
  return stopping;
}

process.stdin.once('end', () => {
  void stopOwnedTree();
});
process.on('SIGTERM', () => {
  void stopOwnedTree();
});
process.on('SIGINT', () => {
  void stopOwnedTree();
});
