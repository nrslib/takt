import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiveWatchObservation } from './src/host.mjs';
import { registeredManagers } from './src/director.mjs';

const repositoryDirectory = mkdtempSync(join(tmpdir(), 'takt-review-watch-'));

try {
  execFileSync('git', ['init', '--quiet', repositoryDirectory]);
  const before = registeredManagers.length;
  const manager = receiveWatchObservation(repositoryDirectory);
  console.log(JSON.stringify({
    source: manager.source,
    before,
    after: registeredManagers.length,
    sameRegisteredObject: manager === registeredManagers.at(-1),
    gitRepository: execFileSync('git', ['-C', repositoryDirectory, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true',
  }, null, 2));
} finally {
  rmSync(repositoryDirectory, { recursive: true, force: true });
}
