import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [revision, destination] = process.argv.slice(2);
if (!revision || !destination) throw new Error('Usage: node eval/scripts/prepare-manager-turn-context-red.mjs <main-revision> <new-worktree>');
const target = resolve(destination);
if (target === root) throw new Error('The baseline needs a separate new worktree');
const sha = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
execFileSync('git', ['worktree', 'add', '--detach', target, sha], { cwd: root, stdio: 'inherit' });
const tracked = execFileSync('git', ['ls-files', '-z', 'eval'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const cases = ['tool-cancel-not-human-stop', 'self-record-not-human-stop', 'human-wait-x-only',
  'run-report-stop-text', 'inquiry-answer-wait', 'human-quotes-review-stop'];
const files = new Set([...tracked, 'eval/manager-turn-context-baseline.mjs',
  ...cases.map((name) => `eval/cases/manager-work-split/${name}.yaml`)]);
for (const file of files) {
  mkdirSync(dirname(resolve(target, file)), { recursive: true });
  copyFileSync(resolve(root, file), resolve(target, file));
}
writeFileSync(resolve(target, 'eval/manager-turn-context-red.json'), JSON.stringify({ baseline: sha, harnessWorktree: root }, null, 2) + '\n');
process.stdout.write(`Prepared main production at ${sha} in ${target}. Install dependencies and build there; see eval/README.md.\n`);
