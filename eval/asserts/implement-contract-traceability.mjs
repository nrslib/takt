import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(evalDir, 'fixtures', 'implement-contract-traceability');
const workDir = join(evalDir, '.work', 'implement-contract-traceability');

function passesTrustedTests(candidateDir) {
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-implement-contract-'));
  try {
    mkdirSync(join(tempDir, 'src'));
    cpSync(join(fixtureDir, 'tests'), join(tempDir, 'tests'), { recursive: true });
    cpSync(join(fixtureDir, 'package.json'), join(tempDir, 'package.json'));
    cpSync(
      join(candidateDir, 'src', 'session-label.js'),
      join(tempDir, 'src', 'session-label.js'),
    );
    execFileSync(process.execPath, ['--test'], { cwd: tempDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function assertImplementContractTraceabilityIn(candidateDir) {
  const testsPass = passesTrustedTests(candidateDir);

  const source = readFileSync(join(candidateDir, 'src', 'session-label.js'), 'utf8');
  const avoidsCaseNormalization = !source.includes('toLowerCase') && !source.includes('toUpperCase');
  const checks = [testsPass, avoidsCaseNormalization];
  const names = ['tests-pass', 'case-preservation-implementation'];
  const failed = names.filter((_, index) => !checks[index]);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'The implementation satisfies the observable normalization behavior.'
      : `Failed checks: ${failed.join(', ')}`,
  };
}

export default function assertImplementContractTraceability() {
  return assertImplementContractTraceabilityIn(workDir);
}
