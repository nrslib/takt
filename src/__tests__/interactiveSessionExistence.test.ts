import { beforeEach, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ stat: vi.fn(), readdir: vi.fn(), acquire: vi.fn(), get: vi.fn(), release: vi.fn(), kiro: vi.fn() }));
vi.mock('node:fs', () => ({ statSync: doubles.stat, readdirSync: doubles.readdir }));
vi.mock('../infra/config/project/sessionStore.js', () => ({ getClaudeProjectSessionsDir: () => '/claude/project' }));
vi.mock('../infra/opencode/server-pool.js', () => ({ acquireOpenCodeClient: doubles.acquire }));
vi.mock('../infra/kiro/sessionExistence.js', () => ({ kiroSessionExists: doubles.kiro }));

import { interactiveSessionExists } from '../features/interactive/interactiveSessionExistence.js';

beforeEach(() => {
  vi.resetAllMocks();
  doubles.kiro.mockResolvedValue(true);
  doubles.acquire.mockResolvedValue({ client: { session: { get: doubles.get } }, release: doubles.release, invalidationSignal: new AbortController().signal });
});

it('checks the project Claude session file and distinguishes absence from I/O failure', async () => {
  doubles.stat.mockReturnValueOnce({ isFile: () => true }).mockImplementationOnce(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); }).mockImplementationOnce(() => { throw Object.assign(new Error(), { code: 'EACCES' }); });
  expect(await interactiveSessionExists('/project', 'claude', 'session')).toBe(true);
  expect(doubles.stat).toHaveBeenCalledWith('/claude/project/session.jsonl');
  expect(await interactiveSessionExists('/project', 'claude', 'missing')).toBe(false);
  expect(await interactiveSessionExists('/project', 'claude', 'unreadable')).toBeUndefined();
});

it('matches the complete Codex session ID in rollout filenames', async () => {
  doubles.readdir.mockReturnValue([{ name: 'rollout-2026-01-01-00000000-0000-4000-8000-000000000001.jsonl', isDirectory: () => false, isFile: () => true }]);
  expect(await interactiveSessionExists('/project', 'codex', '00000000-0000-4000-8000-000000000001')).toBe(true);
  expect(await interactiveSessionExists('/project', 'codex', '000000000001')).toBe(false);
});

it('finds Codex sessions in the year, month, and day hierarchy', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const directories = ['2026', '10', '27'];
  doubles.readdir.mockImplementation((path: string) => {
    const parts = path.split(/[\\/]/);
    const root = parts.lastIndexOf('sessions');
    const relative = parts.slice(root + 1);
    if (root < 0 || relative.length > directories.length || relative.some((part, index) => part !== directories[index])) return [];
    const depth = relative.length;
    if (depth < directories.length) {
      return [{ name: directories[depth], isDirectory: () => true, isFile: () => false }];
    }
    return [{ name: `rollout-2026-10-27T13-50-40-${sessionId}.jsonl`, isDirectory: () => false, isFile: () => true }];
  });

  expect(await interactiveSessionExists('/project', 'codex', sessionId)).toBe(true);
  expect(await interactiveSessionExists('/project', 'codex', '00000000-0000-4000-8000-000000000002')).toBe(false);
});

it('distinguishes OpenCode not found from an unavailable service and releases the client', async () => {
  doubles.get.mockResolvedValueOnce({ data: { id: 'session' } }).mockResolvedValueOnce({ error: { name: 'NotFoundError', data: { message: 'missing' } } }).mockResolvedValueOnce({ error: { message: 'unavailable' } });
  expect(await interactiveSessionExists('/project', 'opencode', 'session')).toBe(true);
  expect(await interactiveSessionExists('/project', 'opencode', 'missing')).toBe(false);
  expect(await interactiveSessionExists('/project', 'opencode', 'unknown')).toBeUndefined();
  expect(doubles.release).toHaveBeenCalledTimes(3);
});

it('retains unknown providers without declaring them missing', async () => {
  expect(await interactiveSessionExists('/project', 'pi', 'session')).toBeUndefined();
});

it('uses Kiro existence checking for Kiro sessions', async () => {
  expect(await interactiveSessionExists('/project', 'kiro', 'session')).toBe(true);
});
