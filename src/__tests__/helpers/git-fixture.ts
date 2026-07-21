import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Finding Contract のテスト用ディレクトリを本番同等の Git worktree にする。 */
export function initializeGitFixture(cwd: string, trackedPaths: readonly string[]): void {
  writeFileSync(join(cwd, '.gitignore'), '.takt/\n');
  execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '--', '.gitignore', ...trackedPaths], { cwd, stdio: 'pipe' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=TAKT test',
      '-c',
      'user.email=takt-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd, stdio: 'pipe' },
  );
}
