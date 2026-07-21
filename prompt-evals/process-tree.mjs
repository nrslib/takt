import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_TERMINATION_GRACE_MS = 500;
const PROCESS_TERMINATION_FORCE_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 10;

export async function terminateProcessTree(pid) {
  if (pid === undefined) {
    throw new Error('Child process did not expose a PID');
  }
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(pid, execFileAsync);
    return;
  }
  signalProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, PROCESS_TERMINATION_GRACE_MS)) {
    return;
  }
  signalProcessGroup(pid, 'SIGKILL');
  if (!await waitForProcessGroupExit(pid, PROCESS_TERMINATION_FORCE_MS)) {
    throw new Error(`Process group ${pid} remained alive after SIGKILL`);
  }
}

export async function terminateWindowsProcessTree(pid, executeFile) {
  const descendants = await listWindowsDescendantPids(pid, executeFile);
  try {
    await executeFile('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch (error) {
    if (isProcessAlive(pid)) {
      throw error;
    }
  }
  for (const descendantPid of descendants.reverse()) {
    try {
      await executeFile('taskkill', ['/PID', String(descendantPid), '/T', '/F']);
    } catch (error) {
      if (isProcessAlive(descendantPid)) {
        throw error;
      }
    }
  }
  const remaining = await listWindowsDescendantPids(pid, executeFile);
  if (remaining.length > 0) {
    throw new Error(`Windows process tree ${pid} retained descendants: ${remaining.join(', ')}`);
  }
}

async function listWindowsDescendantPids(rootPid, executeFile) {
  const result = await executeFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
  ]);
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout.length === 0) {
    return [];
  }
  const parsed = JSON.parse(stdout);
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const processId = Number(processInfo?.ProcessId);
    const parentProcessId = Number(processInfo?.ParentProcessId);
    if (!Number.isInteger(processId) || !Number.isInteger(parentProcessId)) continue;
    const children = childrenByParent.get(parentProcessId) ?? [];
    children.push(processId);
    childrenByParent.set(parentProcessId, children);
  }
  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const processId = pending.pop();
    descendants.push(processId);
    pending.push(...(childrenByParent.get(processId) ?? []));
  }
  return descendants;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') {
      throw error;
    }
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
  return true;
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
