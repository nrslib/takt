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
    execFileSync(process.execPath, ['--test'], { cwd: tempDir, stdio: 'pipe' });
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
}) => `
export function buildRetryMenu({ resumeValue, failedLeafValue, firstLeafValue }) {
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
`;

export function assertWriteTestsDefaultPriorityFor(workDirName) {
  const workDir = join(evalDir, '.work', workDirName);
  const changes = changedFiles(workDir);
  const checks = [
    ['production-unchanged', !changes.some((path) => path.startsWith('src/'))],
    ['tests-changed', changes.some((path) => path.startsWith('tests/'))],
    ['only-tests-changed', changes.every((path) => path.startsWith('tests/'))],
    ['explicit-priority-passes', passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
    }))],
    ['resume-priority-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'resumeValue ?? failedLeafValue ?? firstLeafValue',
    }))],
    ['first-leaf-priority-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'firstLeafValue ?? failedLeafValue ?? resumeValue',
    }))],
    ['label-only-default-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      failedKind: 'resume',
      failedPreservesCheckpoint: true,
    }))],
    ['restart-checkpoint-retention-rejected', !passesWithImplementation(workDir, implementation({
      defaultExpression: 'failedLeafValue ?? resumeValue ?? firstLeafValue',
      failedPreservesCheckpoint: true,
    }))],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);

  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'tests discriminate the explicit default winner when Resume and restart coexist'
      : `failed: ${failed.join(', ')}; changed files: ${changes.join(', ')}`,
  };
}

export default function assertWriteTestsDefaultPriority() {
  return assertWriteTestsDefaultPriorityFor('write-tests-default-priority');
}
