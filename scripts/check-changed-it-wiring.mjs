import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  changedPathsAgainst,
  findChangedNpmScripts,
  git,
  packageManifestPath,
  readInput,
  readPackageManifests,
  runProjectNpm,
} from './changed-project-inputs.mjs';
import { selectNpmTestRuns } from './run-npm-test.mjs';
import { hasIntegrationBoundary } from './test-integration-boundary.mjs';

const wiringTest = 'src/__tests__/releaseVerificationWiring.test.ts';
// Windows environment keys are case-insensitive, so these two npm precedence tests are skipped there.
const casesSkippedOnWindows = new Set([
  'should prefer lowercase npm config when both spellings exist',
  'should prepare Heavy IT when the npm CLI re-enables lifecycle scripts',
]);
const classificationInputs = [
  'scripts/check-changed-it-wiring.mjs',
  'scripts/changed-project-inputs.mjs',
  'scripts/npm-invocation.mjs',
  'scripts/run-npm-test.mjs',
  'scripts/run-heavy-it-parallel.mjs',
  'scripts/run-it-serial-groups.mjs',
  'scripts/heavy-it-guard.mjs',
  'scripts/vitest-heavy-it-guard.ts',
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

function isClassificationScript(name) {
  return name === 'postinstall'
    || /^(?:pre|post)?(?:patch:dependencies|test(?::(?:it|unit)(?::.+)?|:type-contracts|:deepseek-harness:types|:types)?)$/.test(name);
}

function snapshot() {
  const head = git('rev-parse', 'HEAD').trim();
  const changedPaths = changedPathsAgainst(head, ['src/__tests__', packageManifestPath, ...classificationInputs]);
  const packageContent = readInput(packageManifestPath);
  const changedScripts = changedPaths.has(packageManifestPath)
    ? findChangedNpmScripts(readPackageManifests(head, packageContent), isClassificationScript)
    : [];
  const changedClassificationInputs = classificationInputs.filter((file) => changedPaths.has(file));
  if (changedScripts.length > 0) changedClassificationInputs.push(packageManifestPath);
  const changedTests = [...changedPaths]
    .filter((file) => /\.(?:test|spec)\.tsx?$/.test(file))
    .sort();
  const changedInputs = new Map(changedTests.map((file) => [file, readInput(file)]));
  const integrationTests = changedTests.filter((file) => {
    const source = changedInputs.get(file);
    return selectNpmTestRuns([file]).some(({ npmArgs }) => npmArgs[1].startsWith('test:it:'))
      || (source !== undefined && hasIntegrationBoundary(file, source.toString('utf8')));
  });
  const checkedTests = changedClassificationInputs.length === 0 ? integrationTests : changedTests;
  const fileHashes = [...new Set([...checkedTests, wiringTest, packageManifestPath, ...classificationInputs])].map((file) => {
    const content = file === packageManifestPath ? packageContent
      : changedInputs.has(file) ? changedInputs.get(file) : readInput(file);
    const hash = content === undefined ? null : createHash('sha256').update(content).digest('hex');
    return { file, sha256: hash };
  });
  return { head, integrationTests, changedClassificationInputs, changedScripts, fileHashes };
}

function verifyClassificationResult(reportPath) {
  if (!existsSync(reportPath)) {
    throw new Error(`npm test exited successfully without a test report for ${wiringTest}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const [suite] = report.testResults;
  if (report.success !== true || report.testResults.length !== 1
    || resolve(suite.name) !== resolve(wiringTest) || suite.status !== 'passed'
    || !suite.assertionResults.some(({ status }) => status === 'passed')) {
    throw new Error(`Expected a passing test run with only ${wiringTest}`);
  }

  const unexpectedResults = suite.assertionResults.filter(({ status, title }) => {
    if (status === 'passed') return false;
    return !(process.platform === 'win32' && status === 'skipped' && casesSkippedOnWindows.has(title));
  });
  if (unexpectedResults.length > 0) {
    throw new Error(`Expected every case in ${wiringTest} to pass. ${unexpectedResults.length} did not pass.`);
  }
}

const before = snapshot();
if (before.integrationTests.length === 0 && before.changedClassificationInputs.length === 0) {
  process.stdout.write('IT classification check skipped: no changed integration tests or classification inputs against HEAD.\n');
} else {
  process.stdout.write(`Testing IT classification against: ${JSON.stringify(before)}\n`);
  const temporary = mkdtempSync(join(tmpdir(), 'takt-it-wiring-'));
  try {
    const reportPath = join(temporary, 'report.json');
    process.exitCode = runProjectNpm([
      'test', '--', wiringTest, '--reporter=dot', '--reporter=json', `--outputFile.json=${reportPath}`,
    ]);
    if (process.exitCode === 0) {
      verifyClassificationResult(reportPath);
      if (JSON.stringify(snapshot()) !== JSON.stringify(before)) {
        throw new Error('IT classification inputs changed during the check. Run it against the final edits.');
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
