import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(evalDir, 'fixtures', 'scope-discipline-tests');

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

function testsPass(workDir, sourceFiles) {
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-scope-tests-'));
  try {
    mkdirSync(join(tempDir, 'src'));
    cpSync(join(workDir, 'tests'), join(tempDir, 'tests'), { recursive: true });
    cpSync(join(workDir, 'package.json'), join(tempDir, 'package.json'));
    const files = typeof sourceFiles === 'string' ? { 'history.js': sourceFiles } : sourceFiles;
    for (const [path, source] of Object.entries(files)) {
      const destination = join(tempDir, 'src', path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, source);
    }
    execFileSync(process.execPath, ['--test'], { cwd: tempDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export default function assertScopeDisciplineWriteTests(_output, context) {
  const workDir = join(evalDir, '.work', context.vars.work_id);
  const changes = changedFiles(workDir);
  const testText = listFiles(join(workDir, 'tests'))
    .map((path) => readFileSync(join(workDir, 'tests', path), 'utf8'))
    .join('\n');
  const checks = {
    'production-unchanged': !changes.some((path) => path.startsWith('src/')),
    'tests-changed': changes.some((path) => path.startsWith('tests/')),
    'only-tests-changed': changes.every((path) => path.startsWith('tests/')),
    'no-source-proxy': !/(readFileSync|Object\.freeze|split\(['"]\\n|deleteRecord)/.test(testText),
    'intended-implementation-passes': testsPass(workDir, `export function historyDisplayName(student) {
  const preferred = student.preferredName?.trim();
  return preferred ? preferred : student.legalName;
}\n`),
    'equivalent-destructured-implementation-passes': testsPass(workDir, `export const historyDisplayName = ({ preferredName, legalName }) => {
  if (typeof preferredName === 'string' && preferredName.trim().length > 0) return preferredName.trim();
  return legalName;
};\n`),
    'equivalent-reexported-implementation-passes': testsPass(workDir, {
      'history.js': "export { historyDisplayName } from './names/display-name.js';\n",
      'names/display-name.js': `function usablePreferredName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function historyDisplayName(student) {
  return usablePreferredName(student.preferredName) || student.legalName;
}\n`,
    }),
    'unchanged-implementation-fails': !testsPass(workDir, 'export function historyDisplayName(student) { return student.legalName; }\n'),
    'untrimmed-preferred-fails': !testsPass(workDir, 'export function historyDisplayName(student) { return student.preferredName || student.legalName; }\n'),
    'whitespace-fallback-fails': !testsPass(workDir, 'export function historyDisplayName(student) { return student.preferredName?.trim() ?? student.legalName; }\n'),
    'legal-name-preserved': !testsPass(workDir, 'export function historyDisplayName(student) { const preferred = student.preferredName?.trim(); return preferred ? preferred : student.legalName.trim(); }\n'),
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (Object.keys(checks).length - failed.length) / Object.keys(checks).length,
    reason: failed.length === 0 ? 'Behavior tests replace structure proxies and discriminate the contract.' : `Failed checks: ${failed.join(', ')}. Changed files: ${changes.join(', ')}`,
  };
}
