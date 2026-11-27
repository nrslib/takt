import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGroup } from '../src/registration.mjs';
import { readGroups } from '../src/registry.mjs';
import { choices, startSelected } from '../src/picker.mjs';
import { launchGroup } from '../src/launch.mjs';
import { selectAndStart } from '../src/cli.mjs';

async function setup(t, names) {
  const root = await mkdtemp(join(tmpdir(), 'group-picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'groups.json');
  const groups = [];
  for (const name of names) {
    const repository = join(root, name);
    await mkdir(join(repository, '.git'), { recursive: true });
    groups.push(await registerGroup(file, '開発', [repository]));
  }
  return { file, groups };
}

test('同名の登録記録を別々の ID と絶対パスで復元する', async t => {
  const { file, groups } = await setup(t, ['alpha', 'beta']);
  assert.notEqual(groups[0].id, groups[1].id);
  assert.deepEqual(await readGroups(file), groups);
  assert.equal(groups[0].repositories[0], await realpath(groups[0].repositories[0]));
});

test('変更前からの登録例: 共通の親を持つ長いパスを保存する', async t => {
  const { file, groups } = await setup(t, [
    'projects/customer-services/payment-api',
    'projects/customer-services/payment-worker',
  ]);
  assert.deepEqual(await readGroups(file), groups);
  assert.notEqual(groups[0].repositories[0], groups[1].repositories[0]);
});

test('Git 記録のないディレクトリは登録しない', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'groups.json');
  await assert.rejects(registerGroup(file, '開発', [root]));
  assert.deepEqual(await readGroups(file), []);
});

test('短いパスを持つ同名候補の表示を区別できる', () => {
  const items = choices([
    { id: 'a', name: '開発', repositories: ['/home/dev/alpha'] },
    { id: 'b', name: '開発', repositories: ['/home/dev/beta'] },
  ]);
  assert.notEqual(items[0].label, items[1].label);
});

test('選んだ候補の ID と組のリポジトリで起動する', async t => {
  const { file, groups } = await setup(t, ['alpha', 'beta']);
  const items = choices(await readGroups(file));
  for (let index = 0; index < items.length; index += 1) {
    assert.deepEqual(await startSelected(file, items[index].value), {
      groupId: groups[index].id, repositories: groups[index].repositories,
    });
  }
});

test('複数の担当リポジトリを名前の下に1行ずつ表示する', () => {
  const repositories = ['/home/dev/api', '/home/dev/worker'];
  const [item] = choices([{ id: 'a', name: '開発', repositories }]);
  assert.deepEqual(item.label.split('\n'), [
    '開発', '  /home/dev/api…', '  /home/dev/worker…',
  ]);
});

test('選択した ID と全リポジトリを起動処理へ渡す', async t => {
  const { file, groups } = await setup(t, ['alpha', 'beta']);
  const launch = t.mock.fn(launchGroup);
  await startSelected(file, groups[1].id, launch);
  assert.equal(launch.mock.callCount(), 1);
  assert.deepEqual(launch.mock.calls[0].arguments, [
    groups[1].id, groups[1].repositories, `${file}.active.json`,
  ]);
  assert.deepEqual(JSON.parse(await readFile(`${file}.active.json`, 'utf8')), {
    groupId: groups[1].id, repositories: groups[1].repositories,
  });
});

test('CLI の選択番号から各組を起動して保存値を保持する', async t => {
  const { file, groups } = await setup(t, ['alpha', 'beta']);
  for (let index = 0; index < groups.length; index += 1) {
    await selectAndStart(file, String(index + 1));
    assert.deepEqual(JSON.parse(await readFile(`${file}.active.json`, 'utf8')), {
      groupId: groups[index].id, repositories: groups[index].repositories,
    });
    assert.deepEqual(await readGroups(file), groups);
  }
});

test('候補のない番号では起動記録を作らない', async t => {
  const { file } = await setup(t, ['alpha']);
  await assert.rejects(selectAndStart(file, '2'));
  await assert.rejects(readFile(`${file}.active.json`), { code: 'ENOENT' });
});

test('同じ担当の重複登録を ID で見分けて全リポジトリで起動する', async t => {
  const { file, groups } = await setup(t, ['alpha']);
  const worker = groups[0].repositories[0];
  const first = await registerGroup(file, '運用', [worker, worker]);
  const second = await registerGroup(file, ' 運用 ', [worker, worker]);
  const items = choices(await readGroups(file));
  assert.notEqual(items[1].label, items[2].label);
  assert.ok(items[1].label.includes(first.id));
  assert.ok(items[2].label.includes(second.id));
  await selectAndStart(file, '3');
  assert.deepEqual(JSON.parse(await readFile(`${file}.active.json`, 'utf8')), {
    groupId: second.id, repositories: [worker, worker],
  });
});

test('名前の単一行表示と保存する名前を維持する', async t => {
  const { file, groups } = await setup(t, ['alpha']);
  const group = await registerGroup(file, ' 開発 ', groups[0].repositories);
  const items = choices(await readGroups(file));
  assert.ok(items[1].label.split('\n')[0].startsWith('開発'));
  assert.equal((await readGroups(file))[1].name, group.name);
});
