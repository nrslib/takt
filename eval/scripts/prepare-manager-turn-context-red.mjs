import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const scenario = 'eval/scenarios/manager-work-split/manager-work-split.yaml';
const harness = [
  scenario,
  'eval/manager-turn-context-baseline.mjs',
  'eval/manager-work-split-prompt.mjs',
  'eval/manager-work-split-reads.mjs',
  'eval/manager-work-split-config.mjs',
  'eval/manager-work-split-execution-result.mjs',
  'eval/providers/manager-work-split.mjs',
  'eval/providers/manager-work-split-execution.mjs',
  'eval/providers/manager-work-split-execution-worker.mjs',
  'eval/asserts/manager-work-split.mjs',
  'eval/asserts/manager-work-split-execution.mjs',
  'eval/fixtures/manager-no-wait.mjs',
  // Replay providers share these modules with other suites.
  'eval/providers/interactive-topic-judge.mjs',
  'eval/providers/cli-review.mjs',
  'eval/providers/execution-record.mjs',
];

export function copyManagerTurnContextHarness(root, target) {
  const suite = parse(readFileSync(resolve(root, scenario), 'utf8'));
  const cases = [...new Set(suite.tests.map(({ vars }) => vars.case))];
  const fixtures = cases.map((name) => {
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(name)) throw new Error(`Invalid manager case: ${name}`);
    return `eval/cases/manager-work-split/${name}.yaml`;
  });
  const files = [...harness, ...fixtures];
  for (const file of files) {
    mkdirSync(dirname(resolve(target, file)), { recursive: true });
    copyFileSync(resolve(root, file), resolve(target, file));
  }
  return files;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const [revision, destination] = process.argv.slice(2);
  if (!revision || !destination) throw new Error('Usage: node eval/scripts/prepare-manager-turn-context-red.mjs <main-revision> <new-worktree>');
  const target = resolve(destination);
  if (target === root) throw new Error('The baseline needs a separate new worktree');
  const sha = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['worktree', 'add', '--detach', target, sha], { cwd: root, stdio: 'inherit' });
  const files = copyManagerTurnContextHarness(root, target);
  writeFileSync(resolve(target, 'eval/manager-turn-context-red.json'), JSON.stringify({ baseline: sha, harnessWorktree: root, files }, null, 2) + '\n');
  process.stdout.write(`Prepared main production at ${sha} in ${target}. Install dependencies and build there; see eval/README.md.\n`);
}
