import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Provider, { claudeFinalResponse, MAX_RUBRIC_CHARACTERS } from './frontend-mediator-coder.mjs';

test('stream-json extracts only the terminal result, including escaped text and CRLF', () => {
  const response = '完了\n{"status":"saved"}';
  const stream = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'intermediate' }] } },
    { type: 'result', is_error: false, result: response },
  ].map(event => JSON.stringify(event)).join('\r\n');
  assert.equal(claudeFinalResponse(stream), response);
});

for (const stream of [
  '', 'not JSON', '{"type":"assistant","result":"not final"}',
  '{"type":"result","result":null}',
  '{"type":"result","is_error":true,"result":"failed"}',
  '{"type":"result","result":"one"}\n{"type":"result","result":"two"}',
]) {
  test(`rejects a missing, failed, malformed or ambiguous result: ${stream}`, () => {
    assert.throws(() => claudeFinalResponse(stream));
  });
}

test('large Claude stream stays in artifact logs and only its final response enters rubric input', async t => {
  const root = mkdtempSync(join(tmpdir(), 'takt-mediator-stream-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'claude');
  writeFileSync(executable, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  require('node:fs').writeFileSync('src/stream-result.ts', 'export const saved = true;');
  const event = JSON.stringify({ type: 'stream_event', text: 'x'.repeat(100_000) }) + '\\n';
  for (let index = 0; index < 44; index++) process.stdout.write(event);
  process.stderr.write('diagnostic\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '実装完了' }) + '\\n');
});
`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const provider = new Provider({ artifactRoot: join(root, 'artifacts'), config: {
    provider: 'claude', model: 'fake', working_dir: 'fixtures/frontend-mediator', timeout_ms: 5_000,
  } });
  const result = await provider.callApi('implement', {});
  assert.equal(result.error, undefined);
  const observed = JSON.parse(result.output);
  assert.equal(observed.response, '実装完了');
  assert.deepEqual(observed.changedPaths, ['src/stream-result.ts']);
  assert.equal(observed.files['src/stream-result.ts'], 'export const saved = true;');
  assert.ok(result.output.length < MAX_RUBRIC_CHARACTERS);
  const artifact = result.metadata.artifactDirectory;
  const stdout = readFileSync(join(artifact, 'claude.stdout.log'), 'utf8');
  assert.ok(stdout.length > 4_350_000);
  assert.equal(stdout.trim().split('\n').length, 45);
  assert.equal(claudeFinalResponse(stdout), observed.response);
  assert.equal(readFileSync(join(artifact, 'claude.stderr.log'), 'utf8'), 'diagnostic\n');
  const saved = JSON.parse(readFileSync(join(artifact, 'result.json'), 'utf8'));
  assert.equal(saved.output, '実装完了');
  assert.deepEqual(saved.observed, observed);
});
