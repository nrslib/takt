import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import { existsSync, type ReadOptions, type ReadOptionsWithBuffer } from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle, FileReadResult } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendScopedPermission,
  readScopedPermissions,
} from '../features/manager/scopedPermissionStorage.js';
import { answerInquiry, createInquiry } from '../infra/goals/inquiry.js';
import { goalRecord } from './helpers/goal-fixtures.js';

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof fsSync>() }));
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));

const workspaceId = '650e8400-e29b-41d4-a716-446655440001';
const otherWorkspaceId = '650e8400-e29b-41d4-a716-446655440002';
const headings = ['許可', '毎回確認', '拒否'] as const;
let configDirectory: string;
let projectDirectory: string;
let projectFile: string;
let workspaceFile: string;
let globalFile: string;

async function putFile(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function putWorkspace(id: string): Promise<void> {
  await putFile(join(configDirectory, 'workspaces', id, 'workspace.json'), JSON.stringify({
    id, name: '同じ表示名', repositoryDirectories: [],
  }));
}

async function projectPermissionFile(directory: string): Promise<string> {
  const canonicalDirectory = await realpath(directory);
  // 既存 registry と同じく、正規化済みパスの SHA-256 を保存先の期待値にする。
  const id = createHash('sha256').update(canonicalDirectory).digest('hex');
  return join(configDirectory, 'manager-permissions', 'projects', `${id}.md`);
}

async function readFiles(input: { projectDirectory: string; workspaceId?: string }) {
  const result = await readScopedPermissions(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('許可ファイルの読み取りが失敗した');
  return result.files;
}

async function readGlobalFile() {
  const files = await readFiles({ projectDirectory });
  expect(files).toHaveLength(1);
  const file = files[0];
  if (file === undefined) throw new Error('全体の許可ファイルが返されなかった');
  expect(file.filePath).toBe(globalFile);
  expect(file.scope).toBe('global');
  return file;
}

async function withGlobalHandle(check: (handle: FileHandle) => Promise<void>): Promise<void> {
  const open = fs.open;
  const handle = await open(globalFile, 'r');
  vi.spyOn(fs, 'open').mockImplementation((path, flags, mode) =>
    String(path) === globalFile ? Promise.resolve(handle) : open(path, flags, mode));
  try {
    await check(handle);
  } finally {
    vi.restoreAllMocks();
    await handle.close();
  }
}

beforeEach(async () => {
  const isolatedDirectory = process.env.TAKT_CONFIG_DIR;
  if (!isolatedDirectory) throw new Error('共通 setup の TAKT_CONFIG_DIR が必要');
  configDirectory = isolatedDirectory;
  projectDirectory = join(configDirectory, 'sandbox', 'a', 'repo');
  await mkdir(projectDirectory, { recursive: true });
  projectFile = await projectPermissionFile(projectDirectory);
  workspaceFile = join(configDirectory, 'workspaces', workspaceId, 'manager-permissions.md');
  globalFile = join(configDirectory, 'manager-permissions.md');
});

afterEach(() => vi.restoreAllMocks());

describe('goal permission source text', () => {
  function goalWithPermission(text: string) {
    const question = createInquiry({ kind: 'approval', body: '確認',
      operation: { toolName: 'Write', args: '{}', cwd: projectDirectory } });
    return { ...goalRecord(), objective: '長い目的'.repeat(10000),
      questions: [answerInquiry(question, { decision: 'allow', scope: 'goal', text })] };
  }

  it('keeps the complete goal answer at the byte boundary without counting unrelated goal fields', async () => {
    const content = 'あ'.repeat(2730) + '  ';
    const record = goalWithPermission(content);
    const result = await readScopedPermissions({ goal: { repositoryDirectory: projectDirectory, record } });
    expect(Buffer.byteLength(content)).toBe(8192);
    expect(result).toEqual({ ok: true, files: [{
      scope: 'goal', filePath: join(projectDirectory, '.takt', 'goals', record.id, 'goal.json'),
      inquiryId: record.questions[0]!.id, content, sections: [],
    }] });
  });

  it('rejects the combined goal answer source over the limit without returning partial permissions', async () => {
    const record = goalWithPermission('a'.repeat(8192));
    record.questions.push(...goalWithPermission('b').questions);
    const result = await readScopedPermissions({ goal: { repositoryDirectory: projectDirectory, record } });
    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(result).not.toHaveProperty('files');
  });

  it('does not turn question answers or other approval scopes into goal permission text', async () => {
    const record = goalWithPermission('原文');
    const other = goalWithPermission('別範囲').questions[0]!;
    record.questions.push({ ...other, answer: { ...other.answer!, scope: 'once' } },
      answerInquiry(createInquiry({ body: '形式は何ですか' }), '質問への回答'));
    const result = await readScopedPermissions({ goal: { repositoryDirectory: projectDirectory, record } });
    expect(result).toMatchObject({ ok: true, files: [{ content: '原文', inquiryId: record.questions[0]!.id }] });
  });
});

describe('scoped permission storage locations and isolation', () => {
  it('stores all three scopes under the configured global directory', async () => {
    await putWorkspace(workspaceId);
    const workspaceRecord = await readFile(join(dirname(workspaceFile), 'workspace.json'));

    await appendScopedPermission({ scope: { kind: 'project', projectDirectory }, heading: '許可', sentence: 'プロジェクト用' });
    await appendScopedPermission({ scope: { kind: 'workspace', workspaceId }, heading: '毎回確認', sentence: '担当用' });
    await appendScopedPermission({ scope: { kind: 'global' }, heading: '拒否', sentence: '全体用' });

    expect(await readFile(projectFile, 'utf8')).toMatch(/^## 許可\r?\n- プロジェクト用\r?\n$/u);
    expect(await readFile(workspaceFile, 'utf8')).toMatch(/^## 毎回確認\r?\n- 担当用\r?\n$/u);
    expect(await readFile(globalFile, 'utf8')).toMatch(/^## 拒否\r?\n- 全体用\r?\n$/u);
    expect(existsSync(join(projectDirectory, '.takt'))).toBe(false);
    expect(existsSync(join(configDirectory, 'projects'))).toBe(false);
    expect(await readFile(join(dirname(workspaceFile), 'workspace.json'))).toEqual(workspaceRecord);
  });

  it('reads the same project file through a symbolic link to its canonical directory', async () => {
    const alias = join(configDirectory, 'sandbox', 'link');
    await symlink(projectDirectory, alias, 'dir');
    await appendScopedPermission({ scope: { kind: 'project', projectDirectory: alias }, heading: '許可', sentence: 'テストを実行してよい' });

    const canonicalFiles = await readFiles({ projectDirectory });
    const aliasFiles = await readFiles({ projectDirectory: alias });

    expect(aliasFiles).toEqual(canonicalFiles);
    expect(canonicalFiles).toMatchObject([{ scope: 'project', filePath: projectFile, content: '## 許可\n- テストを実行してよい\n' }]);
  });

  it('keeps projects with the same basename separate', async () => {
    const otherProject = join(configDirectory, 'sandbox', 'b', 'repo');
    await mkdir(otherProject, { recursive: true });
    await putFile(projectFile, '## 許可\n- Aだけを許可\n');
    await putFile(await projectPermissionFile(otherProject), '## 許可\n- Bだけを許可\n');

    const first = await readFiles({ projectDirectory });
    const second = await readFiles({ projectDirectory: otherProject });

    expect(first.map(({ filePath, content }) => ({ filePath, content }))).toEqual([
      { filePath: projectFile, content: '## 許可\n- Aだけを許可\n' },
    ]);
    expect(second.map(({ filePath, content }) => ({ filePath, content }))).toEqual([
      { filePath: await projectPermissionFile(otherProject), content: '## 許可\n- Bだけを許可\n' },
    ]);
  });

  it('reads only the specified workspace even when display names are equal', async () => {
    await putWorkspace(workspaceId);
    await putWorkspace(otherWorkspaceId);
    await putFile(workspaceFile, '## 許可\n- A担当だけ\n');
    const otherFile = join(configDirectory, 'workspaces', otherWorkspaceId, 'manager-permissions.md');
    await putFile(otherFile, '## 許可\n- B担当だけ\n');

    const first = await readFiles({ projectDirectory, workspaceId });
    const second = await readFiles({ projectDirectory, workspaceId: otherWorkspaceId });
    const withoutWorkspace = await readFiles({ projectDirectory });

    expect(first).toMatchObject([{ scope: 'workspace', filePath: workspaceFile, content: '## 許可\n- A担当だけ\n' }]);
    expect(second).toMatchObject([{ scope: 'workspace', filePath: otherFile, content: '## 許可\n- B担当だけ\n' }]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(withoutWorkspace).toEqual([]);
  });

  it.each(['../outside', otherWorkspaceId])('reports unresolved workspace %s without creating permission files', async (id) => {
    const result = await readScopedPermissions({ projectDirectory, workspaceId: id });

    expect(result.ok).toBe(false);
    await expect(appendScopedPermission({ scope: { kind: 'workspace', workspaceId: id }, heading: '許可', sentence: '保存しない' })).rejects.toThrow();
    expect(existsSync(join(configDirectory, 'workspaces'))).toBe(false);
    expect(existsSync(globalFile)).toBe(false);
  });

  it('reports project resolution failure instead of returning an empty success', async () => {
    const missingDirectory = join(configDirectory, 'missing-project');

    expect((await readScopedPermissions({ projectDirectory: missingDirectory })).ok).toBe(false);
    await expect(appendScopedPermission({ scope: { kind: 'project', projectDirectory: missingDirectory }, heading: '許可', sentence: '保存しない' })).rejects.toThrow();
    expect(existsSync(join(configDirectory, 'manager-permissions'))).toBe(false);
  });
});

describe('scoped permission original text and headings', () => {
  it.each(['', '\uFEFF'])('reads a first-line heading with original offsets and prefix %j', async (prefix) => {
    const content = `${prefix}## 許可\r\n- 既存文\r\n## 拒否\r\n- push\r\n`;
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.content).toBe(content);
    expect(file.sections).toEqual([
      { heading: '許可', start: prefix.length + 7, end: prefix.length + 14 },
      { heading: '拒否', start: prefix.length + 21, end: prefix.length + 29 },
    ]);
    expect(file.sections.map(({ start, end }) => file.content.slice(start, end))).toEqual([
      '- 既存文\r\n', '- push\r\n',
    ]);
  });

  it.each(['', '\uFEFF'])('ignores headings inside a first-line fence with prefix %j', async (prefix) => {
    const content = `${prefix}~~~\r\n## 許可\r\n- 既存文\r\n~~~\r\n## 拒否\r\n- push\r\n`;
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.content).toBe(content);
    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: file.content.slice(start, end) }))).toEqual([
      { heading: '拒否', body: '- push\r\n' },
    ]);
  });

  it('returns Japanese headings with source paths and unmodified section text', async () => {
    const content = '前書き  \r\n## 許可\r\n- テストを実行してよい  \r\n\r\n## 毎回確認\r\n- 外部送信\r\n## 拒否\r\n- push\r\n';
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.content).toBe(content);
    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: file.content.slice(start, end) }))).toEqual([
      { heading: '許可', body: '- テストを実行してよい  \r\n\r\n' },
      { heading: '毎回確認', body: '- 外部送信\r\n' },
      { heading: '拒否', body: '- push\r\n' },
    ]);
  });

  it('does not classify headings inside code, comments, quotes, or unsupported heading forms', async () => {
    const content = [
      '```md', '## 許可', '```',
      '~~~md', '## 毎回確認', '~~~',
      '<!--', '## 拒否', '-->',
      '> ## 許可', '    ## 許可', '\t## 拒否',
      '許可', '---', '## Allow', '## Ask', '## Deny', '# 許可', '### 許可',
      '````', '```', '~~~', '## 許可', '',
    ].join('\n');
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.content).toBe(content);
    expect(file.sections).toEqual([]);
  });

  it('accepts up to three leading spaces and closing hashes on level-two headings', async () => {
    const content = '   ## 許可 ###\r\n- 原文  \r\n  ## 毎回確認 ##\r\n- 確認\r\n## 拒否\r\n- 拒否';
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.content).toBe(content);
    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: content.slice(start, end) }))).toEqual([
      { heading: '許可', body: '- 原文  \r\n' },
      { heading: '毎回確認', body: '- 確認\r\n' },
      { heading: '拒否', body: '- 拒否' },
    ]);
  });

  it('ends sections at headings of equal or higher level while retaining nested headings', async () => {
    const content = '## 許可\n- 実行\n### 補足\n本文\n## メモ\n対象外\n## 拒否\n- push\n# 付録\n付録本文\n';
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: content.slice(start, end) }))).toEqual([
      { heading: '許可', body: '- 実行\n### 補足\n本文\n' },
      { heading: '拒否', body: '- push\n' },
    ]);
  });

  it.each(['    <!--', '\t<!--', ' \t<!--', '> <!--', '```\n<!--\n```', '```md <!--\n## 拒否\n```'])('ignores comment markers in code or quotes before a real heading: %j', async (example) => {
    const content = `${example}\n\n## 許可\n- 実際の許可\n`;
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.content).toBe(content);
    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: content.slice(start, end) }))).toEqual([
      { heading: '許可', body: '- 実際の許可\n' },
    ]);
  });

  it('closes a fence only with matching characters and sufficient length', async () => {
    const content = '````md\n```\n~~~\n## 許可\n`````\n## 拒否\n- push\n';
    await putFile(globalFile, content);

    const file = await readGlobalFile();

    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: content.slice(start, end) }))).toEqual([
      { heading: '拒否', body: '- push\n' },
    ]);
  });

  it.each(['ja', 'en'])('keeps Japanese storage headings when configured language is %s', async (language) => {
    await putFile(join(configDirectory, 'config.yaml'), `language: ${language}\n`);
    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: 'テスト用' });

    const file = await readGlobalFile();

    expect(file.content).toBe('## 許可\n- テスト用\n');
    expect(file.sections.map(({ heading }) => heading)).toEqual(['許可']);
  });
});

describe('scoped permission read limits and failures', () => {
  it('treats absent permission files as a normal empty result without creating them', async () => {
    await putWorkspace(workspaceId);

    expect(await readFiles({ projectDirectory, workspaceId })).toEqual([]);
    expect(existsSync(projectFile)).toBe(false);
    expect(existsSync(workspaceFile)).toBe(false);
    expect(existsSync(globalFile)).toBe(false);
  });

  it('returns present scopes when other permission files are absent', async () => {
    await putWorkspace(workspaceId);
    await putFile(globalFile, '## 拒否\n- push\n');

    const files = await readFiles({ projectDirectory, workspaceId });

    expect(files).toMatchObject([{ scope: 'global', filePath: globalFile, content: '## 拒否\n- push\n' }]);
    expect(files).toHaveLength(1);
  });

  it('accepts exactly 8192 bytes per file and returns all three maximum-size files', async () => {
    await putWorkspace(workspaceId);
    const prefix = '## 許可\n- ';
    const content = prefix + 'a'.repeat(8192 - Buffer.byteLength(prefix));
    await putFile(projectFile, content);
    await putFile(workspaceFile, content);
    await putFile(globalFile, content);

    const files = await readFiles({ projectDirectory, workspaceId });

    expect(files.map(({ filePath }) => filePath).sort()).toEqual([projectFile, workspaceFile, globalFile].sort());
    expect(files.map(({ content: text }) => text)).toEqual([content, content, content]);
    expect(files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)).toBe(24 * 1024);
  });

  it.each([
    ['ASCII', 'a'.repeat(8193)],
    ['multibyte UTF-8', 'あ'.repeat(2731)],
  ])('reports an oversized %s file instead of returning truncated or partial permissions', async (_label, content) => {
    await putFile(projectFile, '## 許可\n- 正常なプロジェクト許可\n');
    await putFile(globalFile, content);

    const result = await readScopedPermissions({ projectDirectory });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: expect.anything() });
  });

  it('reports a non-regular permission file instead of treating it as absent', async () => {
    await mkdir(globalFile);

    const result = await readScopedPermissions({ projectDirectory });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: expect.anything() });
  });

  it('reports a non-directory parent instead of treating ENOTDIR as an absent permission file', async () => {
    await putFile(join(configDirectory, 'manager-permissions'), '親ディレクトリではない');

    const result = await readScopedPermissions({ projectDirectory });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: expect.anything() });
  });

  it('preserves an existing empty file as an empty source document', async () => {
    await putFile(globalFile, '');

    const file = await readGlobalFile();

    expect(file.content).toBe('');
    expect(file.sections).toEqual([]);
  });

  it('reports invalid UTF-8 instead of returning altered source text', async () => {
    await putFile(globalFile, Buffer.from([0xff]));

    const result = await readScopedPermissions({ projectDirectory });

    expect(result).toMatchObject({ ok: false, error: expect.anything() });
  });

  it('continues reading after short reads and closes the handle after success', async () => {
    const content = '## 許可\n- テストを実行してよい\n';
    await putFile(globalFile, content);
    await withGlobalHandle(async (handle) => {
      const originalRead = handle.read.bind(handle);
      const shortRead = async (
        input?: NodeJS.ArrayBufferView | ReadOptionsWithBuffer<NodeJS.ArrayBufferView>,
        offsetOrOptions?: number | null | ReadOptions,
        length?: number | null,
        position?: number | bigint | null,
      ): Promise<FileReadResult<NodeJS.ArrayBufferView>> => {
        if (ArrayBuffer.isView(input)) {
          const options = typeof offsetOrOptions === 'object' && offsetOrOptions !== null
            ? offsetOrOptions : { offset: offsetOrOptions, length, position };
          const offset = options.offset ?? 0;
          return originalRead(input, offset, Math.min(options.length ?? input.byteLength - offset, 7), options.position);
        }
        return originalRead({ ...input, length: Math.min(input?.length ?? 7, 7) });
      };
      vi.spyOn(handle, 'read').mockImplementation(shortRead);
      const close = vi.spyOn(handle, 'close');

      const file = await readGlobalFile();

      expect(file.content).toBe(content);
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it('limits acquired bytes when a file grows beyond its stat size', async () => {
    await putFile(globalFile, 'a'.repeat(64 * 1024));
    await withGlobalHandle(async (handle) => {
      const stats = await handle.stat();
      stats.size = 0;
      vi.spyOn(handle, 'stat').mockResolvedValue(stats);
      const read = vi.spyOn(handle, 'read');
      const wholeHandleRead = vi.spyOn(handle, 'readFile');
      const wholeFileRead = vi.spyOn(fs, 'readFile');
      const close = vi.spyOn(handle, 'close');

      const result = await readScopedPermissions({ projectDirectory });

      expect(result).toMatchObject({ ok: false, error: expect.anything() });
      const reads = await Promise.all(read.mock.results.map(({ value }) => value));
      expect(reads.reduce((total, entry) => total + entry.bytesRead, 0)).toBeLessThanOrEqual(8193);
      expect(wholeHandleRead).not.toHaveBeenCalled();
      expect(wholeFileRead.mock.calls.some(([path]) => String(path) === globalFile)).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it('reports an I/O read failure and closes the handle instead of returning empty permissions', async () => {
    await putFile(globalFile, '## 許可\n- 既存文\n');
    await withGlobalHandle(async (handle) => {
      vi.spyOn(handle, 'read').mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'EIO' }));
      const close = vi.spyOn(handle, 'close');

      const result = await readScopedPermissions({ projectDirectory });

      expect(result).toMatchObject({ ok: false, error: expect.anything() });
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it('does not treat ENOENT after opening a permission file as a normal missing file', async () => {
    await putFile(globalFile, '## 許可\n- 既存文\n');
    await withGlobalHandle(async (handle) => {
      vi.spyOn(handle, 'read').mockRejectedValueOnce(Object.assign(new Error('read failed'), { code: 'ENOENT' }));

      const result = await readScopedPermissions({ projectDirectory });

      expect(result).toMatchObject({ ok: false, error: expect.anything() });
    });
  });

  it('reports a close failure instead of returning successfully read permissions', async () => {
    await putFile(globalFile, '## 許可\n- 既存文\n');
    await withGlobalHandle(async (handle) => {
      vi.spyOn(handle, 'close').mockRejectedValueOnce(Object.assign(new Error('close failed'), { code: 'EIO' }));

      const result = await readScopedPermissions({ projectDirectory });

      expect(result).toMatchObject({ ok: false, error: expect.anything() });
    });
  });
});

describe('scoped permission append and preservation', () => {
  it.each(['', '\uFEFF'])('appends under a first-line heading while preserving prefix %j and CRLF', async (prefix) => {
    const content = `${prefix}## 許可\r\n- 既存文\r\n## 拒否\r\n- push\r\n`;
    await putFile(globalFile, content);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加文' });

    expect(await readFile(globalFile)).toEqual(Buffer.from(
      `${prefix}## 許可\r\n- 既存文\r\n- 追加文\r\n## 拒否\r\n- push\r\n`,
    ));
  });

  it.each([
    '\uFEFF~~~\r\n## 許可\r\n~~~\r\n',
    '\uFEFF~~~\r\n## 許可\r\n- 既存文\r\n~~~\r\n## 拒否\r\n- push\r\n',
  ])('creates a real heading outside a BOM-prefixed fence while preserving its bytes: %j', async (original) => {
    await putFile(globalFile, original);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加文' });

    expect(await readFile(globalFile)).toEqual(Buffer.from(`${original}## 許可\r\n- 追加文\r\n`));
  });

  it('adds a line break after an existing heading without a final newline', async () => {
    await putFile(globalFile, '## 許可');

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加文' });

    expect(await readFile(globalFile, 'utf8')).toBe('## 許可\n- 追加文\n');
  });

  it.each(headings)('creates a missing file with a bullet under %s', async (heading) => {
    await appendScopedPermission({ scope: { kind: 'global' }, heading, sentence: '確定した一文' });

    expect(await readFile(globalFile, 'utf8')).toBe(`## ${heading}\n- 確定した一文\n`);
    const file = await readGlobalFile();
    expect(file.sections.map(({ heading: value, start, end }) => ({ heading: value, body: file.content.slice(start, end) }))).toEqual([
      { heading, body: '- 確定した一文\n' },
    ]);
  });

  it('inserts the exact sentence before the following heading and preserves CRLF', async () => {
    const prefix = '## 許可\r\n- 既存文\r\n';
    const suffix = '## 拒否\r\n- push\r\n';
    const sentence = '  テストだけを実行してよい  ';
    await putFile(globalFile, prefix + suffix);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence });

    expect(await readFile(globalFile, 'utf8')).toBe(prefix + `- ${sentence}\r\n` + suffix);
  });

  it('creates a real heading after a fenced example rather than appending inside it', async () => {
    const original = '~~~\n## 許可\n~~~\n';
    await putFile(globalFile, original);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: 'テストだけを実行してよい' });

    const updated = await readFile(globalFile, 'utf8');
    expect(updated.startsWith(original)).toBe(true);
    expect(updated.slice(original.length)).toMatch(/^\n?## 許可\n- テストだけを実行してよい\n$/u);
    const file = await readGlobalFile();
    expect(file.sections.map(({ heading, start, end }) => ({ heading, body: file.content.slice(start, end) }))).toEqual([
      { heading: '許可', body: '- テストだけを実行してよい\n' },
    ]);
  });

  it('adds a missing heading while retaining preamble, comments, and a missing final newline', async () => {
    const original = '# メモ\r\n本文  \r\n<!-- 手編集 -->\r\n## 拒否\r\n- push';
    await putFile(globalFile, original);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '毎回確認', sentence: '外部送信' });

    const updated = await readFile(globalFile, 'utf8');
    expect(updated.startsWith(original)).toBe(true);
    expect(updated.slice(original.length)).toMatch(/^\r\n(?:\r\n)?## 毎回確認\r\n- 外部送信\r\n$/u);
  });

  it('appends to the last duplicate heading without merging or rewriting earlier sections', async () => {
    const prefix = '前書き\n## 許可\n- 最初\n## 拒否\n- push\n## 許可\n- 最後\n';
    const suffix = '## メモ\n変更しない  \n';
    await putFile(globalFile, prefix + suffix);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加文' });

    expect(await readFile(globalFile, 'utf8')).toBe(prefix + '- 追加文\n' + suffix);
  });

  it('preserves symbols and whitespace and appends duplicate sentences independently', async () => {
    const sentence = '  `npm test` と *検証* / #文字 & [参照](path)  ';
    const original = '## 許可\n';
    await putFile(globalFile, original);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence });
    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence });

    expect(await readFile(globalFile, 'utf8')).toBe(original + `- ${sentence}\n- ${sentence}\n`);
  });

  it.each(['改行\n次の行', '改行\r\n次の行', '改行\r次の行'])('rejects a multiline sentence without modifying the file: %j', async (sentence) => {
    const original = '## 許可\n- 既存文\n';
    await putFile(globalFile, original);

    await expect(appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence })).rejects.toThrow();

    expect(await readFile(globalFile, 'utf8')).toBe(original);
  });

  it.each(['```\n## 許可\n', '<!--\n## 許可\n', '## 許可\n```\n', '\uFEFF~~~\r\n## 許可\r\n'])('rejects an unsafe append position in an unclosed region: %j', async (original) => {
    await putFile(globalFile, original);

    await expect(appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加しない' })).rejects.toThrow();

    expect(await readFile(globalFile)).toEqual(Buffer.from(original));
  });

  it('does not apply the read API size limit to preservation during append', async () => {
    const original = '## 許可\n- ' + 'a'.repeat(8193) + '\n';
    await putFile(globalFile, original);

    await appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加文' });

    expect(await readFile(globalFile, 'utf8')).toBe(original + '- 追加文\n');
  });

  it('does not replace invalid UTF-8 bytes while appending', async () => {
    const original = Buffer.concat([Buffer.from('## 許可\n- '), Buffer.from([0xff]), Buffer.from('\n')]);
    await putFile(globalFile, original);

    await expect(appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '追加しない' })).rejects.toThrow();

    expect(await readFile(globalFile)).toEqual(original);
  });

  it('reports a parent-directory creation failure without claiming success', async () => {
    const obstruction = join(configDirectory, 'manager-permissions');
    await putFile(obstruction, '保持するファイル');

    await expect(appendScopedPermission({ scope: { kind: 'project', projectDirectory }, heading: '許可', sentence: '保存しない' })).rejects.toThrow();

    expect(await readFile(obstruction, 'utf8')).toBe('保持するファイル');
    expect(existsSync(globalFile)).toBe(false);
  });

  it('reports a destination conflict and preserves its existing contents', async () => {
    const sentinel = join(globalFile, 'keep.txt');
    await putFile(sentinel, '既存内容');

    await expect(appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '保存しない' })).rejects.toThrow();

    expect(await readFile(sentinel, 'utf8')).toBe('既存内容');
  });

  it('propagates a save failure after reading an existing file and preserves its bytes', async () => {
    const original = '## 許可\r\n- 既存文  \r\n';
    await putFile(globalFile, original);
    vi.spyOn(fsSync, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('save failed'), { code: 'EIO' });
    });

    await expect(appendScopedPermission({ scope: { kind: 'global' }, heading: '許可', sentence: '保存できない文' })).rejects.toThrow();

    expect(await readFile(globalFile, 'utf8')).toBe(original);
  });
});
