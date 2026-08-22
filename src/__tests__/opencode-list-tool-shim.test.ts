/**
 * 'list' 互換シム（plugins/list-tool.ts）の単体テスト。
 * execute の境界・権限・出力制限と、upstream 衝突ガードの判定を固定する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ListToolShim } from '../infra/opencode/plugins/list-tool.js';
import {
  registryAllowsListToolShim,
  versionAllowsListToolShim,
} from '../infra/opencode/list-tool-shim-guard.js';

type ListTool = Awaited<ReturnType<typeof ListToolShim>>['tool']['list'];

describe('ListToolShim execute', () => {
  let worktree: string;
  let projectDir: string;
  let outsideDir: string;
  let listTool: ListTool;
  let ask: ReturnType<typeof vi.fn>;

  function makeContext(overrides: Partial<{ abort: AbortSignal }> = {}) {
    return {
      agent: 'takt',
      directory: projectDir,
      worktree,
      abort: overrides.abort ?? new AbortController().signal,
      ask,
    };
  }

  beforeEach(async () => {
    worktree = mkdtempSync(join(tmpdir(), 'takt-list-shim-'));
    projectDir = join(worktree, 'project');
    mkdirSync(join(projectDir, 'sub'), { recursive: true });
    writeFileSync(join(projectDir, 'b.txt'), 'b');
    writeFileSync(join(projectDir, 'a.txt'), 'a');
    outsideDir = mkdtempSync(join(tmpdir(), 'takt-list-shim-outside-'));
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
    ask = vi.fn().mockResolvedValue(undefined);
    listTool = (await ListToolShim()).tool.list!;
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('lists a directory non-recursively with stable sort and trailing slash for dirs', async () => {
    const output = await listTool.execute({ path: '.' }, makeContext());
    const lines = output.split('\n').slice(1);
    expect(lines).toEqual(['a.txt', 'b.txt', 'sub/']);
  });

  it('defaults to the project directory and resolves relative paths against it', async () => {
    const defaultOutput = await listTool.execute({}, makeContext());
    expect(defaultOutput).toContain('a.txt');
    writeFileSync(join(projectDir, 'sub', 'nested.txt'), 'n');
    const subOutput = await listTool.execute({ path: 'sub' }, makeContext());
    expect(subOutput.split('\n').slice(1)).toEqual(['nested.txt']);
  });

  it('always passes through the read permission ask (visibility + runtime permission の二重化)', async () => {
    await listTool.execute({ path: '.' }, makeContext());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0]).toMatchObject({ permission: 'read' });
    // ask が拒否（throw）したら実行しない。
    ask.mockRejectedValueOnce(new Error('denied'));
    await expect(listTool.execute({ path: '.' }, makeContext())).rejects.toThrow('denied');
  });

  it('rejects paths escaping the worktree (relative traversal and absolute)', async () => {
    await expect(listTool.execute({ path: join('..', '..') }, makeContext())).rejects.toThrow(/escapes the workspace root/);
    await expect(listTool.execute({ path: outsideDir }, makeContext())).rejects.toThrow(/escapes the workspace root/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('rejects symlinks that resolve outside the worktree', async () => {
    symlinkSync(outsideDir, join(projectDir, 'sneaky-link'));
    await expect(listTool.execute({ path: 'sneaky-link' }, makeContext())).rejects.toThrow(/escapes the workspace root/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('allows a legitimate directory named "..visible" inside the worktree (directory === worktree)', async () => {
    // codex 指摘: startsWith('..') だけだと workspace 内の正当な `..visible` を
    // escape と誤判定していた。directory === worktree の実運用形で再現する
    // （relFromRoot === '..visible' は '..' でも '../' 始まりでもないので許可）。
    const dottedDir = join(worktree, '..visible');
    mkdirSync(dottedDir);
    writeFileSync(join(dottedDir, 'inside.txt'), 'x');
    const output = await listTool.execute({ path: '..visible' }, { ...makeContext(), directory: worktree });
    expect(output.split('\n').slice(1)).toEqual(['inside.txt']);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: 'read' }));
  });

  it('caps the output for huge directories with a truncation note', async () => {
    const hugeDir = join(projectDir, 'huge');
    mkdirSync(hugeDir);
    for (let index = 0; index < 250; index += 1) {
      writeFileSync(join(hugeDir, `f${String(index).padStart(3, '0')}.txt`), '');
    }
    const output = await listTool.execute({ path: 'huge' }, makeContext());
    const lines = output.split('\n');
    // 見出し行 + 200 エントリ + 省略ノート。
    expect(lines.filter((line) => line.endsWith('.txt')).length).toBe(200);
    expect(output).toContain('50 more entries not shown');
  });

  it('checks the abort signal before doing any work', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listTool.execute({ path: '.' }, makeContext({ abort: controller.signal }))).rejects.toThrow(/aborted/);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('list tool shim upstream collision guard', () => {
  it('allows only the version range verified to lack the list tool (fail-closed elsewhere)', () => {
    expect(versionAllowsListToolShim('1.17.18')).toBe(true);
    expect(versionAllowsListToolShim('1.17.25')).toBe(true);
    expect(versionAllowsListToolShim('1.18.2')).toBe(true);
    // 未検証の範囲は fail-closed。
    expect(versionAllowsListToolShim('1.17.17')).toBe(false);
    expect(versionAllowsListToolShim('1.16.2')).toBe(false);
    expect(versionAllowsListToolShim('1.18.0')).toBe(false);
    expect(versionAllowsListToolShim('1.18.1')).toBe(false);
    expect(versionAllowsListToolShim('1.18.3')).toBe(false);
    expect(versionAllowsListToolShim('2.0.0')).toBe(false);
    expect(versionAllowsListToolShim('garbage')).toBe(false);
    expect(versionAllowsListToolShim('')).toBe(false);
    // codex 指摘の崩れ形式: 末尾アンカーが無いと通過していた亜種はすべて
    // 未検証バージョンとして fail-closed。
    expect(versionAllowsListToolShim('1.17.18-beta.1')).toBe(false);
    expect(versionAllowsListToolShim('1.17.18junk')).toBe(false);
    expect(versionAllowsListToolShim('1.17.18.1')).toBe(false);
  });

  it('refuses registration when the registry already has a list tool (fail-closed on broken input)', () => {
    expect(registryAllowsListToolShim(['bash', 'read', 'glob'])).toBe(true);
    // upstream に 'list' が実在するなら登録しない。
    expect(registryAllowsListToolShim(['bash', 'list', 'read'])).toBe(false);
    // 壊れた入力は fail-closed。
    expect(registryAllowsListToolShim(undefined)).toBe(false);
    expect(registryAllowsListToolShim([])).toBe(false);
    expect(registryAllowsListToolShim(['bash', 42])).toBe(false);
  });
});
