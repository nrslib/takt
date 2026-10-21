#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

const packageRoot = realpathSync(process.argv[2]);
const installedRequire = createRequire(realpathSync(join(packageRoot, 'bin/takt')));
const cli = realpathSync(installedRequire.resolve('@informalsystems/quint/dist/src/cli.js'));
const localPath = relative(packageRoot, cli);
assert.ok(localPath !== '..' && !localPath.startsWith(`..${sep}`) && !isAbsolute(localPath), `Quint is outside the installed package: ${cli}`);
process.stdout.write(`[takt] installed Quint: ${cli}\n`);

const root = mkdtempSync(join(tmpdir(), 'takt-global-quint-'));
try {
  const specification = join(root, 'smoke.qnt');
  writeFileSync(specification, `module smoke {
  var count: int
  action init = count' = 0
  action step = count' = (count + 1) % 3
  val bounded = count >= 0 and count < 3
}
`);
  let failed = false;
  for (const command of ['run', 'verify']) {
    try {
      if (command === 'verify') {
        const java = execFileSync('java', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
        process.stdout.write(java);
        const major = /(?:openjdk|java)\s+(\d+)/.exec(java)?.[1];
        assert.ok(major !== undefined && Number(major) >= 17, 'Quint verify requires Java 17 or later');
      }
      const args = [cli, command, specification, '--main', 'smoke', '--max-steps', '3',
        ...(command === 'run'
          ? ['--backend', 'typescript', '--max-samples', '1', '--invariants', 'bounded']
          : ['--invariant', 'bounded']),
      ];
      process.stdout.write(`[takt] Quint ${JSON.stringify(args)}\n`);
      const output = execFileSync(process.execPath, args, {
        cwd: root, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      });
      process.stdout.write(output);
      process.stdout.write(`[takt] Quint ${command}: exit 0\n`);
    } catch (error) {
      failed = true;
      process.stderr.write(`[takt] Quint ${command}: ${error}\n${error.stdout ?? ''}\n${error.stderr ?? ''}\n`);
    }
  }
  if (failed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
