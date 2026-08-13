import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(evalDir, 'fixtures', 'write-tests-default-priority');

function listFiles(root, current = root) {
  return readdirSync(current).flatMap((entry) => {
    const path = join(current, entry);
    return statSync(path).isDirectory() ? listFiles(root, path) : [relative(root, path)];
  }).sort();
}

function changedFiles(workDir) {
  const fixtureFiles = new Set(listFiles(fixtureDir));
  const workFiles = new Set(listFiles(workDir).filter((path) => !path.startsWith('.takt/')));
  return [...new Set([...fixtureFiles, ...workFiles])].filter((path) => {
    if (!fixtureFiles.has(path) || !workFiles.has(path)) return true;
    return readFileSync(join(fixtureDir, path), 'utf8') !== readFileSync(join(workDir, path), 'utf8');
  });
}

function passesWithImplementation(workDir, source) {
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-default-priority-'));
  try {
    mkdirSync(join(tempDir, 'src'));
    cpSync(join(workDir, 'tests'), join(tempDir, 'tests'), { recursive: true });
    cpSync(join(workDir, 'package.json'), join(tempDir, 'package.json'));
    writeFileSync(join(tempDir, 'src', 'retry-menu.js'), source);
    execFileSync(process.execPath, ['--test'], {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const implementation = ({
  defaultExpression,
  failedKind = 'restart',
  failedPreservesCheckpoint = false,
  persistRestartPoint = true,
  preserveExplicitResume = true,
  resolveUsesRestartPoint = true,
  claimTransitionsToRunning = true,
  claimRejectsNonPending = true,
}) => `
export function buildRequeuePlan({ resumeValue, failedLeafValue, firstLeafValue }) {
  const options = [];
  if (resumeValue !== undefined) {
    options.push({ value: resumeValue, kind: 'resume', preservesCheckpoint: true });
  }
  if (failedLeafValue !== undefined) {
    options.push({ value: failedLeafValue, kind: '${failedKind}', preservesCheckpoint: ${failedPreservesCheckpoint} });
  }
  if (firstLeafValue !== undefined && firstLeafValue !== failedLeafValue) {
    options.push({ value: firstLeafValue, kind: 'restart', preservesCheckpoint: false });
  }
  return { options, defaultValue: ${defaultExpression} };
}

export function persistRequeue(task, selection) {
  if (selection.kind === 'restart') {
    return {
      ...task,
      status: 'pending',
      ${persistRestartPoint
        ? 'restartPoint: selection.value, resumePoint: undefined,'
        : 'restartPoint: undefined, resumePoint: selection.value,'}
    };
  }

  return {
    ...task,
    status: 'pending',
    restartPoint: undefined,
    resumePoint: ${preserveExplicitResume ? 'selection.value' : 'undefined'},
  };
}

export function claimPendingTask(task) {
  if (${claimRejectsNonPending} && task.status !== 'pending') {
    throw new Error('Only pending tasks can be claimed');
  }

  return {
    ...task,
    status: '${claimTransitionsToRunning ? 'running' : 'pending'}',
  };
}

export function resolveFreshStart(task) {
  return {
    startStep: ${resolveUsesRestartPoint ? 'task.restartPoint ?? task.startStep' : 'task.startStep'},
    freshExecution: task.restartPoint !== undefined,
  };
}
`;

export function assertWriteTestsDefaultPriorityFor(workDirName) {
  const workDir = join(evalDir, '.work', workDirName);
  const changes = changedFiles(workDir);
  const checks = [
    ['production-unchanged', !changes.some((path) => path.startsWith('src/'))],
    ['tests-changed', changes.some((path) => path.startsWith('tests/'))],
    ['only-tests-changed', changes.every((path) => path.startsWith('tests/'))],
    ['primary-requeue-path-passes', passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
    }))],
    ['checkpoint-first-default-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'resumeValue ?? failedLeafValue ?? firstLeafValue',
    }))],
    ['first-leaf-priority-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'firstLeafValue ?? failedLeafValue ?? resumeValue',
    }))],
    ['restart-action-kind-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      failedKind: 'resume',
      failedPreservesCheckpoint: true,
    }))],
    ['restart-point-persistence-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      persistRestartPoint: false,
    }))],
    ['terminal-start-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      resolveUsesRestartPoint: false,
    }))],
    ['claim-transition-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      claimTransitionsToRunning: false,
    }))],
    ['non-pending-claim-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      claimRejectsNonPending: false,
    }))],
    ['explicit-checkpoint-preservation-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      preserveExplicitResume: false,
    }))],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'tests trace manual Requeue from primary selection through pending storage, claim, and execution resolution to a fresh start'
      : `failed: ${failed.join(', ')}; changed files: ${changes.join(', ')}`,
  };
}

export default function assertWriteTestsDefaultPriority() {
  return assertWriteTestsDefaultPriorityFor('write-tests-default-priority');
}
