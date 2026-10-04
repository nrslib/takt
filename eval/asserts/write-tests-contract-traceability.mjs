import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(evalDir, 'fixtures', 'write-tests-contract-traceability');
const workDir = join(evalDir, '.work', 'write-tests-contract-traceability');

function listFiles(root, current = root) {
  return readdirSync(current).flatMap((entry) => {
    const path = join(current, entry);
    return statSync(path).isDirectory() ? listFiles(root, path) : [relative(root, path)];
  }).sort();
}

function changedFiles() {
  const fixtureFiles = new Set(listFiles(fixtureDir));
  const workFiles = new Set(listFiles(workDir).filter((path) => !path.startsWith('.takt/')));
  const paths = new Set([...fixtureFiles, ...workFiles]);
  return [...paths].filter((path) => {
    if (!fixtureFiles.has(path) || !workFiles.has(path)) return true;
    return readFileSync(join(fixtureDir, path), 'utf8') !== readFileSync(join(workDir, path), 'utf8');
  });
}

function passesWithImplementation(source) {
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-write-tests-contract-'));
  try {
    mkdirSync(join(tempDir, 'src'));
    cpSync(join(workDir, 'tests'), join(tempDir, 'tests'), { recursive: true });
    cpSync(join(workDir, 'package.json'), join(tempDir, 'package.json'));
    writeFileSync(join(tempDir, 'src', 'session-label.js'), source);
    execFileSync(process.execPath, ['--test'], { cwd: tempDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export default function assertWriteTestsContractTraceability() {
  const changes = changedFiles();
  const sourceUnchanged = !changes.some((path) => path.startsWith('src/'));
  const testsChanged = changes.some((path) => path.startsWith('tests/'));
  const onlyTestsChanged = changes.every((path) => path.startsWith('tests/'));
  const correctImplementationPasses = passesWithImplementation(
    'export function normalizeSessionLabel(label) { return label.trim(); }\n',
  );
  const unchangedImplementationFails = !passesWithImplementation(
    'export function normalizeSessionLabel(label) { return label; }\n',
  );
  const lowercaseMutationFails = !passesWithImplementation(
    'export function normalizeSessionLabel(label) { return label.trim().toLowerCase(); }\n',
  );
  const internalWhitespaceMutationFails = !passesWithImplementation(
    "export function normalizeSessionLabel(label) { return label.replace(/\\s/g, ''); }\n",
  );
  const whitespaceOnlyMutationFails = !passesWithImplementation(
    'export function normalizeSessionLabel(label) { return label.trim() || label; }\n',
  );

  const checks = [
    sourceUnchanged,
    testsChanged,
    onlyTestsChanged,
    correctImplementationPasses,
    unchangedImplementationFails,
    lowercaseMutationFails,
    internalWhitespaceMutationFails,
    whitespaceOnlyMutationFails,
  ];
  const names = [
    'source-unchanged',
    'tests-changed',
    'only-tests-changed',
    'correct-implementation-passes',
    'unchanged-implementation-fails',
    'lowercase-mutation-fails',
    'internal-whitespace-mutation-fails',
    'whitespace-only-mutation-fails',
  ];
  const failed = names.filter((_, index) => !checks[index]);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'Tests accept the intended behavior and reject plausible contract-breaking implementations.'
      : `Failed checks: ${failed.join(', ')}. Changed files: ${changes.join(', ')}`,
  };
}
