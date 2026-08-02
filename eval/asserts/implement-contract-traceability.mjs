import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(evalDir, '.work', 'implement-contract-traceability');

export default function assertImplementContractTraceability() {
  let testsPass = false;
  try {
    execFileSync(process.execPath, ['--test'], { cwd: workDir, stdio: 'pipe' });
    testsPass = true;
  } catch {
    testsPass = false;
  }

  const source = readFileSync(join(workDir, 'src', 'session-label.js'), 'utf8');
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
