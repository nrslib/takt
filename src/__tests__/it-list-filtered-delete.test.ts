import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskRecordSchema, type TaskRecord } from '../infra/task/schema.js';
import { getCloneMetaPath, saveCloneMeta } from '../infra/task/clone-meta.js';
import { encodeWorktreePath } from '../infra/config/project/sessionStore.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import * as i18n from '../shared/i18n/index.js';
import * as taskActions from '../features/tasks/list/taskActions.js';

const output = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock('../shared/ui/index.js', () => output);

const goalId = '550e8400-e29b-41d4-a716-446655440000';
let root: string;
let project: string;
const children: ChildProcess[] = [];

async function waitForMarker(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(file)) {
    if (children.some((child) => child.exitCode !== null && child.exitCode !== 0)) {
      throw new Error('Deletion lock worker failed');
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startWorker(role: 'delete' | 'claim'): void {
  const fixture = fileURLToPath(new URL('./fixtures/task-deletion-lock-child.ts', import.meta.url));
  children.push(spawn(process.execPath, ['--import', 'tsx', fixture, project, root, role], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
  }));
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim();
}

function initializeProject(directory: string): void {
  mkdirSync(join(directory, '.takt'), { recursive: true });
  writeFileSync(join(directory, '.takt', 'config.yaml'), stringify({ language: 'en' }));
  git(directory, ['init', '-b', 'main']);
  const tree = git(directory, ['hash-object', '-t', 'tree', '-w', '--stdin'], '');
  const commit = git(directory, ['commit-tree', tree, '-m', 'fixture']);
  git(directory, ['update-ref', 'refs/heads/main', commit]);
}

function record(name: string, status: TaskRecord['status'], extra: Partial<TaskRecord> = {}): TaskRecord {
  return TaskRecordSchema.parse({ name, status, content: `Task ${name}`, goal_id: goalId,
    created_at: '2026-02-09T00:00:00Z',
    started_at: status === 'pending' ? null : '2026-02-09T00:01:00Z',
    completed_at: status === 'pending' || status === 'running' ? null : '2026-02-09T00:02:00Z',
    ...(status === 'failed' ? { failure: { error: 'failed' } } : {}), ...extra });
}

function saveRecords(directory: string, records: TaskRecord[]): void {
  writeFileSync(join(directory, '.takt', 'tasks.yaml'), stringify({ tasks: records }));
}

function names(directory: string): string[] {
  return new TaskRunner(directory).listAllTaskItems().map((task) => task.name);
}

function cloneResources(directory: string, branch: string) {
  git(directory, ['branch', branch]);
  const clone = join(root, 'worktrees', basename(directory), branch.replaceAll('/', '-'));
  mkdirSync(dirname(clone), { recursive: true });
  git(directory, ['clone', '--no-hardlinks', '--branch', branch, directory, clone]);
  saveCloneMeta(directory, branch, clone);
  const session = join(directory, '.takt', 'worktree-sessions', `${encodeWorktreePath(clone)}.json`);
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, JSON.stringify({ sessionId: 'fixture-session' }));
  return { clone, session, meta: getCloneMetaPath(directory, branch) };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'takt-filtered-delete-'));
  project = join(root, 'project');
  const configDir = process.env.TAKT_CONFIG_DIR;
  if (configDir === undefined) throw new Error('TAKT_CONFIG_DIR must be set by test setup');
  writeFileSync(join(configDir, 'config.yaml'), stringify({ worktree_dir: join(root, 'worktrees') }));
  invalidateGlobalConfigCache();
  initializeProject(project);
  invalidateAllResolvedConfigCache();
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Deletion lock worker cleanup timed out')), 5_000);
      child.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    child.kill('SIGKILL');
    await closed;
  }));
  vi.restoreAllMocks();
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  rmSync(root, { recursive: true, force: true });
});

describe('non-interactive filtered deletion with real task resources', () => {
  it.each(['delete', 'claim'] as const)('coordinates cleanup and claim when %s goes first', async (first) => {
    const clone = join(project, '.takt', 'worktrees', 'race');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, 'sentinel'), 'keep');
    saveRecords(project, [record('race', first === 'delete' ? 'completed' : 'pending', { goal_id: undefined,
      branch: 'feature/race', worktree_path: clone }),
    ...(first === 'delete' ? [record('other', 'pending', { goal_id: undefined })] : [])]);
    startWorker('delete');
    startWorker('claim');
    await waitForMarker(join(root, 'delete-ready'));
    await waitForMarker(join(root, 'claim-ready'));
    writeFileSync(join(root, `start-${first}`), 'start');
    if (first === 'delete') {
      await waitForMarker(join(root, 'cleanup-started'));
      writeFileSync(join(root, 'start-claim'), 'start');
      await waitForMarker(join(root, 'claim-result'));
      const claim: unknown = JSON.parse(readFileSync(join(root, 'claim-result'), 'utf8'));
      expect(claim).toEqual({ claimed: ['other'] });
      expect(new TaskRunner(project).listAllTaskItems().map((task) => ({ name: task.name, kind: task.kind })))
        .toEqual(expect.arrayContaining([{ name: 'race', kind: 'completed' }, { name: 'other', kind: 'running' }]));
      expect(existsSync(join(root, 'delete-result'))).toBe(false);
      expect(existsSync(clone)).toBe(true);
      writeFileSync(join(root, 'release-cleanup'), 'release');
    } else {
      await waitForMarker(join(root, 'claim-result'));
      writeFileSync(join(root, 'start-delete'), 'start');
    }
    await waitForMarker(join(root, 'delete-result'));
    await waitForMarker(join(root, 'claim-result'));
    const deletion = JSON.parse(readFileSync(join(root, 'delete-result'), 'utf8')) as { success?: boolean; error?: string };
    const claim = JSON.parse(readFileSync(join(root, 'claim-result'), 'utf8')) as { claimed: string[] };
    expect(claim.claimed).toEqual(first === 'delete' ? ['other'] : ['race']);
    if (first === 'delete') {
      expect(deletion).toEqual({ success: true });
      expect(existsSync(clone)).toBe(false);
      expect(new TaskRunner(project).listAllTaskItems().map((task) => ({ name: task.name, kind: task.kind })))
        .toEqual([{ name: 'other', kind: 'running' }]);
    } else {
      expect(deletion.error).toBeDefined();
      expect(existsSync(join(root, 'cleanup-started'))).toBe(false);
      expect(readFileSync(join(clone, 'sentinel'), 'utf8')).toBe('keep');
      expect(new TaskRunner(project).listAllTaskItems().map((task) => task.kind)).toEqual(['running']);
    }
  });
  describe.each([1, 2, 3])('selection/claim comparison %s', () => {
    it.each([false, true])('observes deletion after claim=%s', async (claim) => {
      const resources = cloneResources(project, 'feature/race');
      saveRecords(project, [record('race', 'pending', { goal_id: undefined,
        branch: 'feature/race', worktree_path: resources.clone })]);
      const runner = new TaskRunner(project);
      const selected = runner.listAllTaskItems();
      if (claim) {
        expect(runner.claimNextTasks(1).map((task) => task.name)).toEqual(['race']);
      }
      vi.spyOn(TaskRunner.prototype, 'listAllTaskItems').mockReturnValueOnce(selected);
      const cleanup = vi.spyOn(taskActions, 'deleteBranch');
      const operation = listTasksNonInteractive(project, { enabled: true, action: 'delete',
        status: ['pending'], yes: true });
      if (claim) await expect(operation).rejects.toThrow('exit');
      else await operation;
      expect(cleanup).toHaveBeenCalledTimes(claim ? 0 : 1);
      for (const file of Object.values(resources)) expect(existsSync(file)).toBe(claim);
      if (claim) expect(git(project, ['branch', '--format=%(refname:short)']).split('\n')).toContain('feature/race');
      expect(runner.listAllTaskItems().map((task) => task.kind)).toEqual(claim ? ['running'] : []);
    });
  });
  it('deletes the root branch, session, metadata and record for a missing clone within the allowed base', async () => {
    const resources = cloneResources(project, 'feature/missing');
    rmSync(resources.clone, { recursive: true });
    saveRecords(project, [record('missing', 'completed', { branch: 'feature/missing', worktree_path: resources.clone })]);

    await listTasksNonInteractive(project, { enabled: true, action: 'delete', branch: 'feature/missing', yes: true });

    for (const file of Object.values(resources)) expect(existsSync(file)).toBe(false);
    expect(names(project)).toEqual([]);
    expect(git(project, ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/missing'])).toBe('');
    expect(output.warn).not.toHaveBeenCalled();
  });
  it('preserves clones, sessions, metadata, Git branches, and records during preview', async () => {
    const resources = cloneResources(project, 'feature/preview');
    saveRecords(project, [record('preview', 'completed', {
      branch: 'feature/preview', worktree_path: resources.clone,
    }), record('running', 'running')]);
    const original = readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(project, { enabled: true, action: 'delete', format: 'json',
      goal: goalId });

    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as { tasks: Array<{ name: string }> };
    expect(payload.tasks.map((task) => task.name)).toEqual(['preview']);
    for (const file of Object.values(resources)) expect(existsSync(file)).toBe(true);
    expect(git(project, ['branch', '--format=%(refname:short)']).split('\n')).toContain('feature/preview');
    expect(readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8')).toBe(original);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('removes selected clone resources and records with yes while preserving unrelated records and artifacts', async () => {
    const resources = cloneResources(project, 'feature/cleanup');
    const taskArtifact = join(project, '.takt', 'tasks', 'saved-order', 'order.md');
    const runArtifact = join(project, '.takt', 'runs', 'saved-run', 'report.md');
    for (const file of [taskArtifact, runArtifact]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'keep this artifact');
    }
    saveRecords(project, [record('cleanup', 'completed', {
      branch: 'feature/cleanup', worktree_path: resources.clone,
    }), record('other-goal', 'pending', { goal_id: '550e8400-e29b-41d4-a716-446655440001' }),
    record('running', 'running')]);

    await listTasksNonInteractive(project, { enabled: true, action: 'delete',
      branch: 'feature/cleanup', yes: true });

    for (const file of Object.values(resources)) expect(existsSync(file)).toBe(false);
    expect(names(project)).toEqual(['other-goal', 'running']);
    for (const file of [taskArtifact, runArtifact]) expect(readFileSync(file, 'utf8')).toBe('keep this artifact');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('deletes a root Git branch and task record when no worktree is recorded', async () => {
    git(project, ['branch', 'feature/root-only']);
    saveRecords(project, [record('root-only', 'completed', { branch: 'feature/root-only' })]);

    await listTasksNonInteractive(project, { enabled: true, action: 'delete',
      branch: 'feature/root-only', yes: true });

    expect(git(project, ['branch', '--format=%(refname:short)']).split('\n')).toEqual(['main']);
    expect(names(project)).toEqual([]);
  });

  it('removes a merge task clone and record while retaining its root branch', async () => {
    const clone = join(project, '.takt', 'worktrees', 'merge-pr');
    mkdirSync(dirname(clone), { recursive: true });
    git(project, ['clone', '--no-hardlinks', project, clone]);
    saveRecords(project, [record('merge-pr', 'failed', {
      branch: 'main', base_branch: 'main', worktree_path: clone, worktree: true,
      merge_task: true, source: 'pr_review', pr_number: 123, merge_method: 'merge',
      merge_head_repository_url: project, merge_head_repository_push_urls: [project],
      merge_initial_head_sha: git(project, ['rev-parse', 'HEAD']),
      merge_threat_check_max_diff_bytes: 1000, merge_clone_prepared: true,
    })]);

    await listTasksNonInteractive(project, { enabled: true, action: 'delete', yes: true,
      status: ['failed'], goal: goalId });

    expect(existsSync(clone)).toBe(false);
    expect(git(project, ['branch', '--format=%(refname:short)']).split('\n')).toEqual(['main']);
    expect(names(project)).toEqual([]);
  });

  it('resolves deletion ownership from the task file rather than the caller cwd', async () => {
    const resources = cloneResources(project, 'feature/owner');
    saveRecords(project, [record('same-name', 'completed', {
      branch: 'feature/owner', worktree_path: resources.clone,
    })]);
    const ownerTask = new TaskRunner(project).listAllTaskItems()[0]!;
    const caller = join(root, 'caller');
    initializeProject(caller);
    saveRecords(caller, [record('same-name', 'completed', { branch: 'feature/owner' })]);
    const originalCaller = readFileSync(join(caller, '.takt', 'tasks.yaml'), 'utf8');
    vi.spyOn(TaskRunner.prototype, 'listAllTaskItems').mockReturnValueOnce([ownerTask]);

    await listTasksNonInteractive(caller, { enabled: true, action: 'delete', yes: true, branch: 'feature/owner' });

    for (const file of Object.values(resources)) expect(existsSync(file)).toBe(false);
    expect(names(project)).toEqual([]);
    expect(readFileSync(join(caller, '.takt', 'tasks.yaml'), 'utf8')).toBe(originalCaller);
  });

  describe.each(['ja', 'en'] as const)('localized deletion output (%s)', (language) => {
    it.each(['preview', 'empty selection', 'success', 'missing filters', 'cleanup failure'] as const)(
      'resolves %s text through labels available in both languages', async (scenario) => {
        writeFileSync(join(project, '.takt', 'config.yaml'), stringify({ language }));
        invalidateAllResolvedConfigCache();
        saveRecords(project, [scenario === 'success' ? record('localized', 'pending')
          : record('localized', 'completed', { branch: scenario === 'cleanup failure' ? 'main' : 'feature/i18n' })]);
        const labels = vi.spyOn(i18n, 'getLabel');
        const operation = listTasksNonInteractive(project, {
          enabled: true, action: 'delete', yes: scenario !== 'preview' && scenario !== 'empty selection',
          ...(scenario === 'preview' ? { branch: 'feature/i18n' } : {}),
          ...(scenario === 'cleanup failure' ? { branch: 'main' } : {}),
          status: scenario === 'success' || scenario === 'empty selection' ? ['pending'] : undefined,
        });

        if (scenario === 'missing filters' || scenario === 'cleanup failure') {
          await expect(operation).rejects.toThrow('exit');
        } else {
          await operation;
        }

        const calls = [...labels.mock.calls];
        expect(calls.length).toBeGreaterThan(0);
        const messages = Object.values(output).flatMap((mock) => mock.mock.calls.map(([message]) => String(message)));
        for (const [key, , vars] of calls) {
          const japanese = i18n.getLabel(key, 'ja', vars);
          const english = i18n.getLabel(key, 'en', vars);
          expect(japanese.length).toBeGreaterThan(0);
          expect(english.length).toBeGreaterThan(0);
          expect(messages.some((message) => message.includes(language === 'ja' ? japanese : english))).toBe(true);
        }
      },
    );
  });

  it('uses bilingual labels for the status and goal option descriptions', async () => {
    const labels = vi.spyOn(i18n, 'getLabel');
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    const list = program.commands.find((command) => command.name() === 'list');

    for (const flag of ['--status', '--goal']) {
      const option = list?.options.find((entry) => entry.long === flag);
      expect(option).toBeDefined();
      const index = labels.mock.results.findIndex((result) => result.type === 'return'
        && result.value === option?.description);
      expect(index).toBeGreaterThanOrEqual(0);
      const [key, , vars] = labels.mock.calls[index]!;
      for (const language of ['ja', 'en'] as const) {
        expect(i18n.getLabel(key, language, vars).length).toBeGreaterThan(0);
      }
    }
  });

  it('uses a bilingual label when the registered status option rejects running', async () => {
    const { program } = await import('../app/cli/program.js');
    await import('../app/cli/commands.js');
    const option = program.commands.find((command) => command.name() === 'list')?.options
      .find((entry) => entry.long === '--status');
    expect(option).toBeDefined();
    const labels = vi.spyOn(i18n, 'getLabel');
    const parser = new Command().addOption(option!).exitOverride().configureOutput({ writeErr: vi.fn() });

    let rejection: unknown;
    try {
      parser.parse(['--status', 'running'], { from: 'user' });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeDefined();
    const calls = [...labels.mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    expect(labels.mock.results.some((result) => result.type === 'return'
      && typeof result.value === 'string' && String(rejection).includes(result.value))).toBe(true);
    for (const [key, , vars] of calls) {
      for (const language of ['ja', 'en'] as const) {
        expect(i18n.getLabel(key, language, vars).length).toBeGreaterThan(0);
      }
    }
  });
});
