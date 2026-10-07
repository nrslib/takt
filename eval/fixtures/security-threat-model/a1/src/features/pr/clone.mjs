import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withPrHead(repository, prNumber, run) {
  const root = mkdtempSync(join(tmpdir(), 'takt-pr-'));
  const clone = join(root, 'checkout');
  try {
    execFileSync('git', ['clone', '--no-checkout', repository, clone]);
    execFileSync('git', ['fetch', 'origin', 'pull/' + prNumber + '/head'], { cwd: clone });
    execFileSync('git', ['checkout', 'FETCH_HEAD'], { cwd: clone });
    return await run(clone);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
