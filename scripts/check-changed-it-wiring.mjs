import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolveNpmInvocation } from './npm-invocation.mjs';
import { selectNpmTestRuns } from './run-npm-test.mjs';
import { hasIntegrationBoundary } from './test-integration-boundary.mjs';

const wiringTest = 'src/__tests__/releaseVerificationWiring.test.ts';
const classificationInputs = [
  'scripts/run-npm-test.mjs',
  'scripts/test-classification.mjs',
  'scripts/test-integration-boundary.mjs',
  'tsconfig.tests.json',
  'vitest.config.ts',
  'vitest.config.shared.ts',
  'vitest.config.unit.parallel.ts',
  'vitest.config.it.parallel.ts',
  'vitest.config.it.heavy.parallel.ts',
  'vitest.config.it.serial.git.ts',
  'vitest.config.it.serial.workflow.ts',
];

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function readTestInput(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isFile()) {
    throw new Error(`Expected a regular test input: ${file}`);
  }
  return stat === undefined ? undefined : readFileSync(file);
}

function snapshot() {
  const head = git('rev-parse', 'HEAD').trim();
  const paths = ['src/__tests__', ...classificationInputs];
  const tracked = git('diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', head, '--', ...paths);
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', ...paths);
  const changedPaths = new Set([...tracked.split('\0'), ...untracked.split('\0')]);
  const changedClassificationInputs = classificationInputs.filter((file) => changedPaths.has(file));
  const changedTests = [...changedPaths]
    .filter((file) => /\.(?:test|spec)\.tsx?$/.test(file))
    .sort();
  const changedInputs = new Map(changedTests.map((file) => [file, readTestInput(file)]));
  const integrationTests = changedTests.filter((file) => {
    const source = changedInputs.get(file);
    return selectNpmTestRuns([file]).some(({ npmArgs }) => npmArgs[1].startsWith('test:it:'))
      || (source !== undefined && hasIntegrationBoundary(file, source.toString('utf8')));
  });
  const checkedTests = changedClassificationInputs.length === 0 ? integrationTests : changedTests;
  const fileHashes = [...new Set([...checkedTests, wiringTest, 'package.json', ...classificationInputs])].map((file) => {
    const content = changedInputs.has(file) ? changedInputs.get(file) : readTestInput(file);
    const hash = content === undefined ? null : createHash('sha256').update(content).digest('hex');
    return { file, sha256: hash };
  });
  return { head, integrationTests, changedClassificationInputs, fileHashes };
}

const before = snapshot();
if (before.integrationTests.length === 0 && before.changedClassificationInputs.length === 0) {
  process.stdout.write('IT classification check skipped: no changed integration tests or classification inputs against HEAD.\n');
} else {
  process.stdout.write(`Testing IT classification against: ${JSON.stringify(before)}\n`);
  const npm = resolveNpmInvocation(process.execPath, process.env.npm_execpath);
  const result = spawnSync(npm.executable, [...npm.args, 'test', '--', wiringTest], { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0 && JSON.stringify(snapshot()) !== JSON.stringify(before)) {
    throw new Error('IT classification inputs changed during the check. Run it against the final edits.');
  }
  process.exitCode = result.status ?? 1;
}
