import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const suiteName = 'finding-realistic-premise';
const fixtures = join(repoRoot, 'eval/fixtures', suiteName);
const read = path => fs.readFileSync(join(repoRoot, path), 'utf8');

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'realistic-premise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureModule(caseId, name) {
  return import(pathToFileURL(join(fixtures, caseId, 'src', `${name}.mjs`)).href);
}

test('adjudication seeds use the production report filenames and preserve the review fixture', () => {
  for (const [review, adjudication, report] of [
    ['rt', 'at', 'security-review.md'], ['rc', 'ac', 'coding-review.md'],
    ['rq', 'aq', 'architect-review.md'], ['ne', 'ae', 'security-review.md'],
    ['np', 'ap', 'coding-review.md'], ['nb', 'ab', 'architect-review.md'],
  ]) {
    for (const directory of ['src', 'docs', 'test']) {
      for (const name of fs.readdirSync(join(fixtures, review, directory))) {
        assert.equal(fs.readFileSync(join(fixtures, adjudication, directory, name), 'utf8'),
          fs.readFileSync(join(fixtures, review, directory, name), 'utf8'));
      }
    }
    for (const name of [
      'architect-review.md', 'security-review.md', 'coding-review.md',
      'testing-review.md', 'ai-antipattern-review.md',
    ]) {
      const seed = fs.readFileSync(join(fixtures, adjudication, 'reports-seed', name), 'utf8');
      assert.match(seed, name === report ? /REJECT/ : /APPROVE/);
      if (name === report) {
        assert.match(seed, /finding_id:/);
        assert.match(seed, /status: new/);
      }
    }
  }
});

test('snippet state is produced under its generated ignore rule, and archive entries can escape the import directory', async t => {
  const root = temporaryDirectory(t);
  const snippets = await fixtureModule('ne', 'snippets');
  snippets.init(root);
  const entry = snippets.newSnippet(root);
  assert.equal(fs.readFileSync(join(root, '.snip/.gitignore'), 'utf8'), '*\n');
  assert.equal(dirname(entry.directory), join(root, '.snip/work'));
  const archive = join(root, 'collection.json');
  fs.writeFileSync(archive, JSON.stringify([{ path: '../received.txt', content: 'from collection' }]));
  snippets.importArchive(root, archive);
  assert.equal(fs.readFileSync(join(root, '.snip/received.txt'), 'utf8'), 'from collection');
});

test('sync launches two reads of the same file before either update is written', async t => {
  const { sync } = await fixtureModule('np', 'bookmarks');
  let reads = 0;
  let stored = '[]';
  const writes = [];
  t.mock.method(fs.promises, 'readFile', async () => {
    reads += 1;
    return stored;
  });
  t.mock.method(fs.promises, 'writeFile', async (file, content) => {
    assert.equal(reads, 2);
    writes.push(file);
    stored = content;
  });
  await sync('/bookmarks', ['https://example.test/one', 'https://example.test/two'], 2);
  assert.deepEqual(writes, ['/bookmarks/bookmarks.json', '/bookmarks/bookmarks.json']);
  assert.equal(JSON.parse(stored).length, 1);
});

test('documented daily log output exceeds the actual default subprocess output limit', () => {
  const manifest = JSON.parse(read(`eval/fixtures/${suiteName}/nb/docs/daily-manifest.json`));
  const outputBytes = manifest.count * (Buffer.byteLength(manifest.firstPath) + 1);
  assert.ok(outputBytes > 1024 * 1024);
  assert.throws(() => execFileSync(process.execPath, [
    '-e', 'process.stdout.write("x".repeat(Number(process.argv[1])))', String(outputBytes),
  ], { timeout: 10000, killSignal: 'SIGKILL', env: {} }),
  error => error.code === 'ENOBUFS');
});
