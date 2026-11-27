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
    const repositories = [];
    for (const entry of Array.isArray(name) ? name : [name]) {
      const repository = join(root, entry);
      await mkdir(join(repository, '.git'), { recursive: true });
      repositories.push(repository);
    }
    groups.push(await registerGroup(file, '開発', repositories));
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

test('同名で異なるリポジトリの表示を区別できる', async t => {
  const { groups } = await setup(t, ['alpha', 'beta']);
  const items = choices(groups);
  assert.notEqual(items[0].label, items[1].label);
});
test('長い共通部分を持つパスも最後まで表示する', async t => {
  const { groups } = await setup(t, [
    'projects/customer-services/payment-api',
    'projects/customer-services/payment-worker',
  ]);
  const items = choices(groups);
  assert.notEqual(items[0].label, items[1].label);
  groups.forEach((group, index) => assert.ok(items[index].label.includes(group.repositories[0])));
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

test('先頭が同じで後続が異なる組の全パスを1行ずつ表示する', async t => {
  const { file, groups } = await setup(t, [
    ['api', 'worker a'],
    ['api', '作業 worker b'],
  ]);
  const items = choices(await readGroups(file));
  assert.notEqual(items[0].label, items[1].label);
  for (let index = 0; index < groups.length; index += 1) {
    assert.deepEqual(items[index].label.split('\n'), [
      groups[index].name, ...groups[index].repositories.map(path => `  ${path}`),
    ]);
    assert.deepEqual(await startSelected(file, items[index].value), {
      groupId: groups[index].id, repositories: groups[index].repositories,
    });
  }
});

test('同名で同じ担当の組を重複登録しても ID で区別して選択する', async t => {
  const { file, groups } = await setup(t, [['api', 'worker'], ['api', 'worker']]);
  const items = choices(await readGroups(file));
  assert.deepEqual(groups[0].repositories, groups[1].repositories);
  assert.notEqual(items[0].label, items[1].label);
  for (let index = 0; index < groups.length; index += 1) {
    assert.ok(items[index].label.split('\n')[0].includes(groups[index].id));
    assert.deepEqual(await startSelected(file, items[index].value), {
      groupId: groups[index].id, repositories: groups[index].repositories,
    });
  }
});

test('表示名が同じで担当も同じ組を ID で区別する', async t => {
  const { file, groups } = await setup(t, [['api', 'worker']]);
  const other = await registerGroup(file, ' 開発 ', groups[0].repositories);
  const items = choices(await readGroups(file));
  assert.notEqual(items[0].label, items[1].label);
  assert.ok(items[0].label.includes(groups[0].id));
  assert.ok(items[1].label.includes(other.id));
  assert.equal((await startSelected(file, items[1].value)).groupId, other.id);
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

test('名前の単一行表示と保存する名前を維持する', async t => {
  const { file, groups } = await setup(t, ['alpha']);
  const group = await registerGroup(file, ' 開発 ', groups[0].repositories);
  const items = choices(await readGroups(file));
  assert.ok(items[1].label.split('\n')[0].startsWith('開発'));
  assert.equal((await readGroups(file))[1].name, group.name);
});
