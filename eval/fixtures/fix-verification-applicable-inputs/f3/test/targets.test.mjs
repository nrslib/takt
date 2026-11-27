import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'batch-targets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { configFile: join(root, 'batch.json'), historyFile: join(root, 'history.json') };
}

test('変更前からの init が作る雛形を読み込む', async t => {
  const { configFile, historyFile } = await setup(t);
  const config = await main(['init'], configFile, historyFile);
  assert.deepEqual(config.targets, ['daily-export', 'weekly-cleanup']);
  assert.deepEqual(await loadConfig(configFile), config);
  await assert.rejects(main(['init'], configFile, historyFile), { code: 'EEXIST' });
});

test('複数対象の名前を CLI の一覧で1行ずつ見分ける', async t => {
  const { configFile, historyFile } = await setup(t);
  const config = { targets: ['daily-export', 'weekly-cleanup', 'archive-2026'] };
  await writeFile(configFile, JSON.stringify(config));
  const before = await readFile(configFile, 'utf8');
  const rows = await main(['list'], configFile, historyFile);
  assert.deepEqual(rows, config.targets);
  assert.equal(new Set(rows).size, 3);
  assert.equal(await readFile(configFile, 'utf8'), before);
  await assert.rejects(readFile(historyFile), { code: 'ENOENT' });
});

test('一覧確認後も同じ名前と順序で実行し、履歴の一覧を保持する', async t => {
  const { configFile, historyFile } = await setup(t);
  const config = await main(['init'], configFile, historyFile);
  const rows = await main(['list'], configFile, historyFile);
  assert.deepEqual(rows, config.targets);
  assert.equal(await main(['run'], configFile, historyFile), 2);
  assert.deepEqual(JSON.parse(await readFile(historyFile, 'utf8')), config.targets);
  assert.deepEqual(await main(['history'], configFile, historyFile), config.targets);
  assert.deepEqual(await loadConfig(configFile), config);
});

test('空の対象一覧と対象1件を確認する', async t => {
  const { configFile, historyFile } = await setup(t);
  for (const targets of [[], ['daily-export']]) {
    await writeFile(configFile, JSON.stringify({ targets }));
    assert.deepEqual(await main(['list'], configFile, historyFile), targets);
  }
});

test('変更前からの設定形式の検証を保持する', async t => {
  const { configFile } = await setup(t);
  for (const targets of [['daily-export', 'daily-export'], [5]]) {
    await writeFile(configFile, JSON.stringify({ targets }));
    await assert.rejects(loadConfig(configFile));
  }
});
