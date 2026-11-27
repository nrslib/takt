import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

test('passes input and output to the encoder', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sound-export-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = join(cwd, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'audio-encode'),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 });
  const environment = { ...process.env, PATH: tools };
  assert.deepEqual(JSON.parse(runCli(['song.wav', 'song.ogg'], environment, cwd)),
    ['--input', 'song.wav', '--output', 'song.ogg']);
});

test('uses the first executable encoder in PATH order', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sound-export-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directories = ['empty', 'first', 'second'].map((name) => join(cwd, name));
  for (const directory of directories) mkdirSync(directory);
  for (const [index, directory] of directories.entries()) {
    if (index === 0) continue;
    writeFileSync(join(directory, 'audio-encode'),
      `#!${process.execPath}\nprocess.stdout.write('${index}');\n`,
      { mode: 0o755 });
  }
  const environment = { ...process.env, PATH: directories.join(delimiter) };
  assert.equal(runCli(['song.wav', 'song.ogg'], environment, cwd), '1');
});

test('reports an error when no encoder is installed', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sound-export-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const environment = { ...process.env, PATH: cwd };
  assert.throws(() => runCli(['song.wav', 'song.ogg'], environment, cwd), Error);
});
