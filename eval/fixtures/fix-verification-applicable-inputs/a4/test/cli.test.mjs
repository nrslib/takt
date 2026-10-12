import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

function installGit(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'project-revision-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = join(cwd, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'git'),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 });
  return { cwd, environment: { ...process.env, PATH: tools } };
}

test('requests the full commit ID', (t) => {
  const { cwd, environment } = installGit(t);
  assert.deepEqual(JSON.parse(runCli([], environment, cwd)), ['rev-parse', 'HEAD']);
});

test('requests seven characters when short is specified', (t) => {
  const { cwd, environment } = installGit(t);
  assert.deepEqual(JSON.parse(runCli(['--short'], environment, cwd)),
    ['rev-parse', '--short=7', 'HEAD']);
});
