import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_TERMINATION_GRACE_MS = 500;
export const PROCESS_TREE_CLEANUP_GRACE_MS = 5_000;
const PROCESS_EXIT_POLL_MS = 10;
const WINDOWS_PROCESS_EXIT_POLL_MS = 100;
const WINDOWS_COMMAND_TIMEOUT_MS = PROCESS_TREE_CLEANUP_GRACE_MS;
const WINDOWS_FORCED_COMMAND_TIMEOUT_MS = 1;

export function startProcessTreeCleanup(pid) {
  return terminateProcessTree(pid);
}

function writeCleanupWarning(message) {
  return new Promise((resolve, reject) => {
    try {
      process.stderr.write(`Warning: ${message}\n`, (error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function terminateProcessTree(pid) {
  try {
    if (pid === undefined) {
      throw new Error('Child process did not expose a PID');
    }
    if (process.platform === 'win32') {
      await terminateWindowsProcessTreeInternal(pid, execFileAsync);
      return;
    }
    await terminatePosixProcessTree(pid);
  } catch (error) {
    await reportCleanupFailure(error);
  }
}

async function terminatePosixProcessTree(pid) {
  const deadline = Date.now() + PROCESS_TREE_CLEANUP_GRACE_MS;
  let firstError;
  try {
    signalProcessGroup(pid, 'SIGTERM');
  } catch (error) {
    firstError = error;
  }
  try {
    await waitForProcessGroupExit(
      pid,
      Math.min(PROCESS_TERMINATION_GRACE_MS, Math.max(0, deadline - Date.now())),
    );
  } catch (error) {
    firstError ??= error;
  }
  try {
    signalProcessGroup(pid, 'SIGKILL');
  } catch (error) {
    firstError ??= error;
  }
  let exited = false;
  try {
    exited = await waitForProcessGroupExit(pid, Math.max(0, deadline - Date.now()));
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) {
    throw firstError;
  }
  if (!exited) {
    throw new Error(`Process group ${pid} remained alive after SIGKILL`);
  }
}

export async function terminateWindowsProcessTree(pid, executeFile) {
  try {
    await terminateWindowsProcessTreeInternal(pid, executeFile);
  } catch (error) {
    await reportCleanupFailure(error);
  }
}

async function terminateWindowsProcessTreeInternal(pid, executeFile) {
  const deadline = Date.now() + PROCESS_TREE_CLEANUP_GRACE_MS;
  const failures = [];
  const snapshot = await listWindowsProcesses(executeFile, deadline);
  if (snapshot.status === 'deadline') {
    failures.push('WMI process snapshot deadline exceeded');
    const taskkill = await taskkillBestEffort(pid, executeFile, deadline, true);
    recordCommandFailure(failures, 'taskkill root', taskkill);
    throw createWindowsProcessTreeError(pid, [], true, failures);
  }
  if (snapshot.status === 'unavailable') {
    failures.push(formatUnavailable('WMI process snapshot', snapshot.error));
    const taskkill = await taskkillBestEffort(pid, executeFile, deadline, true);
    recordCommandFailure(failures, 'taskkill root', taskkill);
    throw createWindowsProcessTreeError(pid, [], false, failures);
  }

  const processTree = collectWindowsProcessTree(pid, snapshot.processes);
  const rootTaskkill = await taskkillBestEffort(pid, executeFile, deadline, true);
  recordCommandFailure(failures, 'taskkill root', rootTaskkill);

  const descendants = processTree.filter((processInfo) => processInfo.pid !== pid).reverse();
  for (const descendant of descendants) {
    if (Date.now() >= deadline) {
      failures.push('descendant cleanup deadline exceeded');
      break;
    }
    const identity = await hasMatchingCreationDate(descendant, executeFile, deadline);
    if (identity.status === 'deadline') {
      failures.push(`WMI identity query for ${descendant.pid} deadline exceeded`);
      break;
    }
    if (identity.status === 'unavailable') {
      failures.push(formatUnavailable(`WMI identity query for ${descendant.pid}`, identity.error));
    }
    if (identity.status === 'available' && !identity.matches) {
      continue;
    }
    const taskkill = await taskkillBestEffort(descendant.pid, executeFile, deadline, false);
    recordCommandFailure(failures, `taskkill descendant ${descendant.pid}`, taskkill);
  }

  const remaining = await waitForWindowsProcessTreeExit(processTree, executeFile, deadline);
  if (remaining.status === 'unavailable') {
    failures.push(formatUnavailable('WMI final process query', remaining.error));
  } else if (remaining.status === 'deadline') {
    failures.push('WMI final process query deadline exceeded');
  }
  if (remaining.status === 'deadline' || failures.length > 0 || remaining.processes.length > 0) {
    throw createWindowsProcessTreeError(
      pid,
      remaining.status === 'complete' ? [] : remaining.processes,
      remaining.status === 'deadline',
      failures,
    );
  }
}

async function reportCleanupFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    await writeCleanupWarning(`Process tree cleanup warning: ${detail}`);
  } catch (warningError) {
    throw new AggregateError(
      [error, warningError],
      'Process tree cleanup failed while reporting the warning',
    );
  }
  throw error;
}

async function taskkillBestEffort(pid, executeFile, deadline, forceAfterDeadline) {
  return executeWindowsCommand(
    executeFile,
    'taskkill',
    ['/PID', String(pid), '/T', '/F'],
    deadline,
    forceAfterDeadline,
  );
}

async function hasMatchingCreationDate(processInfo, executeFile, deadline) {
  const currentProcesses = await queryWindowsProcesses(
    executeFile,
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${processInfo.pid}" | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress`,
    deadline,
  );
  if (currentProcesses.status === 'deadline') {
    return { status: 'deadline' };
  }
  if (currentProcesses.status === 'unavailable') {
    return { status: 'unavailable', error: currentProcesses.error };
  }
  return {
    status: 'available',
    matches: currentProcesses.processes.some(
      (current) => current.pid === processInfo.pid
        && current.creationDate === processInfo.creationDate,
    ),
  };
}

async function listWindowsProcesses(executeFile, deadline) {
  return queryWindowsProcesses(
    executeFile,
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
    deadline,
  );
}

async function waitForWindowsProcessTreeExit(processTree, executeFile, deadline) {
  if (processTree.length === 0) {
    return { status: 'complete', processes: [] };
  }
  while (true) {
    const currentProcesses = await queryWindowsProcesses(
      executeFile,
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
      deadline,
    );
    if (currentProcesses.status === 'deadline') {
      return { status: 'deadline', processes: processTree };
    }
    if (currentProcesses.status === 'unavailable') {
      return { status: 'unavailable', error: currentProcesses.error, processes: [] };
    }
    const currentCreationDates = new Map(
      currentProcesses.processes.map((processInfo) => [processInfo.pid, processInfo.creationDate]),
    );
    const remaining = processTree.filter(
      (processInfo) => currentCreationDates.get(processInfo.pid) === processInfo.creationDate,
    );
    if (remaining.length === 0) {
      return { status: 'complete', processes: [] };
    }
    if (Date.now() >= deadline) {
      return { status: 'deadline', processes: remaining };
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(WINDOWS_PROCESS_EXIT_POLL_MS, Math.max(1, deadline - Date.now())),
    ));
  }
}

async function queryWindowsProcesses(executeFile, command, deadline) {
  const result = await executeWindowsCommand(
    executeFile,
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ],
    deadline,
    false,
  );
  if (result.status === 'deadline') {
    return { status: 'deadline' };
  }
  if (result.status === 'failed') {
    return { status: 'unavailable', error: result.error };
  }
  try {
    return { status: 'available', processes: parseWindowsProcesses(result.value) };
  } catch (error) {
    return { status: 'unavailable', error };
  }
}

async function executeWindowsCommand(executeFile, file, args, deadline, forceAfterDeadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0 && !forceAfterDeadline) {
    return { status: 'deadline' };
  }
  const timeout = remaining > 0
    ? Math.min(WINDOWS_COMMAND_TIMEOUT_MS, remaining)
    : WINDOWS_FORCED_COMMAND_TIMEOUT_MS;
  let timeoutId;
  const command = Promise.resolve()
    .then(() => executeFile(file, args, { timeout }))
    .then(
      (value) => ({ status: 'completed', value }),
      (error) => ({ status: 'failed', error }),
    );
  try {
    return await Promise.race([
      command,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ status: 'deadline' }), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function recordCommandFailure(failures, label, result) {
  if (result.status === 'failed') {
    failures.push(`${label} failed: ${formatError(result.error)}`);
  } else if (result.status === 'deadline') {
    failures.push(`${label} deadline exceeded`);
  }
}

function formatUnavailable(label, error) {
  return `${label} unavailable: ${formatError(error)}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function createWindowsProcessTreeError(pid, processes, deadlineExceeded, failures) {
  const retained = processes.map(({ pid: processId }) => processId).join(', ');
  const details = failures.join('; ');
  if (retained.length > 0) {
    const suffix = deadlineExceeded ? ' (cleanup deadline exceeded)' : '';
    return new Error(
      `Windows process tree ${pid} retained processes: ${retained}${suffix}${details ? `; ${details}` : ''}`,
    );
  }
  if (details.length > 0) {
    return new Error(`Windows process tree ${pid} cleanup failed: ${details}`);
  }
  return new Error(`Windows process tree ${pid} cleanup deadline exceeded`);
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
