import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_TERMINATION_GRACE_MS = 500;
const PROCESS_TERMINATION_FORCE_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 10;
const WINDOWS_COMMAND_TIMEOUT_MS = 5_000;

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
  const snapshot = await listWindowsProcesses(executeFile);
  if (snapshot === undefined) {
    await taskkillBestEffort(pid, executeFile);
    return;
  }
  const processTree = collectWindowsProcessTree(pid, snapshot);

  await taskkillBestEffort(pid, executeFile);
  const descendants = processTree.filter((processInfo) => processInfo.pid !== pid).reverse();
  for (const descendant of descendants) {
    if (await hasMatchingCreationDate(descendant, executeFile)) {
      await taskkillBestEffort(descendant.pid, executeFile);
    }
  }

  const currentProcesses = await listWindowsProcesses(executeFile);
  if (currentProcesses === undefined) {
    return;
  }
  const currentCreationDates = new Map(
    currentProcesses.map((processInfo) => [processInfo.pid, processInfo.creationDate]),
  );
  const remaining = processTree.filter(
    (processInfo) => currentCreationDates.get(processInfo.pid) === processInfo.creationDate,
  );
  if (remaining.length > 0) {
    throw new Error(
      `Windows process tree ${pid} retained processes: ${remaining.map(({ pid: processId }) => processId).join(', ')}`,
    );
  }
}

async function taskkillBestEffort(pid, executeFile) {
  try {
    await executeFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { timeout: WINDOWS_COMMAND_TIMEOUT_MS },
    );
  } catch {
    return;
  }
}

async function hasMatchingCreationDate(processInfo, executeFile) {
  const currentProcesses = await queryWindowsProcesses(
    executeFile,
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${processInfo.pid}" | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress`,
  );
  return currentProcesses === undefined || currentProcesses.some(
    (current) => current.pid === processInfo.pid
      && current.creationDate === processInfo.creationDate,
  );
}

async function listWindowsProcesses(executeFile) {
  return queryWindowsProcesses(
    executeFile,
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
  );
}

async function queryWindowsProcesses(executeFile, command) {
  try {
    const result = await executeFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], { timeout: WINDOWS_COMMAND_TIMEOUT_MS });
    return parseWindowsProcesses(result);
  } catch {
    // Cleanup must still attempt taskkill when CIM is unavailable or malformed.
    return undefined;
  }
}

function parseWindowsProcesses(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout.length === 0) {
    return [];
  }
  const parsed = JSON.parse(stdout);
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  return processes.flatMap((processInfo) => {
    const pid = Number(processInfo?.ProcessId);
    const parentProcessId = Number(processInfo?.ParentProcessId);
    const creationDate = processInfo?.CreationDate;
    if (!Number.isInteger(pid) || !Number.isInteger(parentProcessId) || typeof creationDate !== 'string') {
      return [];
    }
    return [{ pid, parentProcessId, creationDate }];
  });
}

function collectWindowsProcessTree(rootPid, processes) {
  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.parentProcessId) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.parentProcessId, children);
  }
  const processTree = processes.filter((processInfo) => processInfo.pid === rootPid);
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const processInfo = pending.pop();
    processTree.push(processInfo);
    pending.push(...(childrenByParent.get(processInfo.pid) ?? []));
  }
  return processTree;
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
