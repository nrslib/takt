import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { daemonEntryPath } from '../features/daemon/lifecycle.js';
import { getTaktRun, listTaktTasks, tellTaktRun } from '../features/mcp/operations.js';
import { removeTaktGoalTask } from '../features/mcp/goalTaskRemovalOperations.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { AsyncCommand } from '../infra/daemon/command.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { getProjectExecutionOwner } from '../infra/task/project-execution-lock.js';
import { packageVersion } from '../shared/package-info.js';
import { ControlledTurnRunner } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

it.each([
  { concurrency: undefined, settings: 'project', initial: 3 },
  { concurrency: 1, settings: 'project', initial: 3 },
  { concurrency: undefined, settings: 'global concurrency', initial: 3 },
  { concurrency: undefined, settings: 'global concurrency', initial: 1 },
  { concurrency: undefined, settings: 'global ignore_exceed', initial: 3 },
])('executes builtin work with worker concurrency=$concurrency and $settings initially $initial', async ({ concurrency, settings, initial }) => {
  const directory = getGlobalConfigDir();
  const project = mkdtempSync(join(directory, 'pool-execution-'));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const controller = new AbortController();
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: project, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: project, stdio: 'ignore' });
    const globalBase = `provider: mock\nworktree_dir: ${JSON.stringify(join(project, 'clones'))}\n`;
    writeFileSync(join(directory, 'config.yaml'), globalBase
      + (settings === 'project' ? '' : `concurrency: ${initial}\nignore_exceed: false\n`)
      + (concurrency === undefined ? '' : `daemon:\n  builtin_worker:\n    concurrency: ${concurrency}\n`));
    invalidateGlobalConfigCache();
    mkdirSync(join(project, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n'
      + (settings === 'project' ? 'concurrency: 3\n' : ''));
    writeFileSync(join(project, '.takt', 'workflows', 'pool.yaml'), 'name: pool\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const hook = join(project, 'provider-hook.mjs');
    writeFileSync(hook, `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MockProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/infra/providers/mock.ts')).href)};
const root = ${JSON.stringify(project)};
MockProvider.prototype.setup = config => ({ call: async (prompt) => {
  const task = /independent work (\\d)/.exec(prompt)?.[1]
    ?? (prompt.includes('iteration bound') ? 'iteration' : prompt.includes('cancel while pending') ? 'cancelled' : undefined);
  if (task !== undefined) writeFileSync(join(root, 'entered-' + task), String(process.pid));
  const deadline = Date.now() + 25000;
  while (!existsSync(join(root, 'release-worker')) && !existsSync(join(root, 'release-worker-' + task))) {
    if (Date.now() > deadline) throw new Error('Test did not release worker');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { persona: config.name, status: 'done', timestamp: new Date(), content: 'completed', sessionId: randomUUID() };
} });
`);
    vi.stubEnv('NODE_OPTIONS', `--import ${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))} --import ${JSON.stringify(pathToFileURL(hook).href)}`);
    const goal = await new GoalStore(project).create(goalRecord());
    execFileSync('git', ['branch', goal.branch], { cwd: project });
    const runner = new TaskRunner(project);
    const ordinary = runner.addTask('manual only', { workflow: 'pool', worktree: false });
    const tasks = Array.from({ length: 3 }, (_, index) => runner.addTask(`independent work ${index}`, {
      workflow: 'pool', worktree: index === 0, slug: `independent-${index}`, goal_id: goal.id, base_branch: goal.branch,
    }));
    const cancelled = runner.addTask('cancel while pending', { workflow: 'pool', worktree: false, goal_id: goal.id });
    await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
    const identity = getSelfProcessIdentity();
    if (identity === undefined) throw new Error('Test process identity unavailable');
    const owner = { pid: process.pid, identity, version: packageVersion, cliPath: daemonEntryPath() };
    await writeDaemonOwner(directory, owner);
    const turns = new ControlledTurnRunner();
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { turns.bus = bus; return turns; },
    });
    const expected = concurrency ?? initial;
    await vi.waitFor(() => {
      expect(readdirSync(project).filter((file) => file.startsWith('entered-')), JSON.stringify(runner.listTaskStateItems())).toHaveLength(expected);
      expect(runner.listTaskStateItems().filter((task) => task.status === 'running')).toHaveLength(expected);
    }, { timeout: 30_000 });
    const running = runner.listTaskStateItems().filter((task) => task.status === 'running');
    const childPid = getProjectExecutionOwner(project)!.pid;
    expect(readdirSync(project).filter((file) => file.startsWith('entered-'))
      .map((file) => Number(readFileSync(join(project, file), 'utf8')))).toEqual(Array(expected).fill(childPid));
    expect(running.every((task) => task.workerName === 'builtin')).toBe(true);
    expect(getProjectExecutionOwner(project)?.pid).not.toBe(process.pid);
    const response = await listTaktTasks({ cwd: project });
    const listed = JSON.parse(firstTextContent(response.content)) as { tasks: { name: string; workerName?: string }[] };
    for (const task of running) {
      expect(listed.tasks.find((item) => item.name === task.name)?.workerName).toBe('builtin');
      await vi.waitFor(() => {
        const read = getTaktRun({ cwd: project, runSlug: task.runSlug! });
        expect(read.isError, firstTextContent(read.content)).toBeUndefined();
      });
    }
    expect((await tellTaktRun({ cwd: project, runSlug: running[0]!.runSlug!, content: 'Keep the requested scope' })).isError).toBeUndefined();
    for (const kind of ['run', 'watch']) {
      const result = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), kind], {
        cwd: project, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('already running');
    }
    expect((await removeTaktGoalTask({ cwd: project, goalId: goal.id, taskName: cancelled.name,
      reason: 'No longer required' }, {}, controller.signal)).isError).toBeUndefined();
    writeFileSync(join(project, 'release-worker'), 'release all');
    await vi.waitFor(() => {
      const saved = new TaskStore(project).read().tasks;
      expect(saved.filter((task) => tasks.some((target) => target.name === task.name)).map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
      expect(saved.find((task) => task.name === cancelled.name)).toBeUndefined();
      expect(saved.find((task) => task.name === ordinary.name)?.status).toBe('pending');
    }, { timeout: 30_000 });
    expect(readdirSync(project).filter((file) => file.startsWith('entered-'))).toHaveLength(3);
    expect(runner.listTaskStateItems().filter((task) => task.status === 'completed').every((task) =>
      task.completion?.success === true && task.workerName === 'builtin')).toBe(true);
    await vi.waitFor(() => expect(getProjectExecutionOwner(project)).toBeUndefined());
    expect(runner.listTaskStateItems().filter((task) => task.status === 'completed' && task.worktree === true).every((task) =>
      task.worktreePath !== undefined && existsSync(join(task.worktreePath, '.takt', 'runs')))).toBe(true);
    expect((await new GoalStore(project).get(goal.id)).workLog.some((entry) => entry.summary.includes('No longer required'))).toBe(true);
    if (concurrency === undefined && settings !== 'global ignore_exceed') {
      // Keep the same daemon and project child through idle config changes in both directions.
      const cycles = (initial === 3 ? [1, 3] : [3, 1]).map((limit) => ({ limit, override: undefined as number | undefined }));
      if (settings === 'global concurrency' && initial === 3) cycles.push({ limit: 1, override: 1 }, { limit: 3, override: undefined });
      for (const { limit, override } of cycles) {
        for (const file of readdirSync(project).filter((name) => name.startsWith('entered-') || name.startsWith('release-worker'))) {
          rmSync(join(project, file));
        }
        if (settings === 'project') {
          writeFileSync(join(project, '.takt', 'config.yaml'), `provider: mock\nlanguage: en\nconcurrency: ${limit}\nignore_exceed: false\n`);
        } else {
          writeFileSync(join(directory, 'config.yaml'), globalBase + `concurrency: ${override === undefined ? limit : 3}\nignore_exceed: false\n`);
          writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n'
            + (override === undefined ? '' : `concurrency: ${override}\n`));
        }
        const next = Array.from({ length: 3 }, (_, index) => runner.addTask(`independent work ${index}`, {
          workflow: 'pool', worktree: false, slug: `cycle-${limit}-${index}`, goal_id: goal.id,
        }));
        await vi.waitFor(() => {
          expect(readdirSync(project).filter((name) => name.startsWith('entered-'))).toHaveLength(limit);
          expect(runner.listTaskStateItems().filter((task) => next.some((target) => target.name === task.name)
            && task.status === 'running')).toHaveLength(limit);
          expect(runner.listTaskStateItems().filter((task) => next.some((target) => target.name === task.name)
            && task.status === 'pending')).toHaveLength(3 - limit);
          expect(getProjectExecutionOwner(project)?.pid).toBe(childPid);
          expect(readdirSync(project).filter((file) => file.startsWith('entered-'))
            .every((file) => Number(readFileSync(join(project, file), 'utf8')) === childPid)).toBe(true);
        }, { timeout: 30_000 });
        if (limit === 1) {
          await vi.waitFor(async () => {
            const output = JSON.parse(firstTextContent((await listTaktTasks({ cwd: project })).content)) as {
              tasks: { name: string; status: string; waitingReason?: string }[] };
            expect(output.tasks.find((task) => task.name === next[1]!.name)).toMatchObject({
              status: 'pending', waitingReason: expect.stringMatching(/waiting.*worker slot.*project concurrency/i),
            });
          }, { timeout: 30_000 });
          writeFileSync(join(project, 'release-worker-0'), 'release the first slot');
          await vi.waitFor(async () => {
            const output = JSON.parse(firstTextContent((await listTaktTasks({ cwd: project })).content)) as {
              tasks: { name: string; status: string; waitingReason?: string; workerName?: string }[] };
            const started = output.tasks.find((task) => task.name === next[1]!.name);
            expect(started).toMatchObject({ status: 'running', workerName: 'builtin' });
            expect(started?.waitingReason).toBeUndefined();
          }, { timeout: 30_000 });
        }
        writeFileSync(join(project, 'release-worker'), 'finish this group');
        await vi.waitFor(() => {
          expect(runner.listTaskStateItems().filter((task) => next.some((target) => target.name === task.name))
            .map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
          expect(getProjectExecutionOwner(project)).toBeUndefined();
        }, { timeout: 30_000 });
      }
    }
    if (concurrency === undefined && settings !== 'global concurrency') {
      writeFileSync(join(project, '.takt', 'workflows', 'limited.yaml'), 'name: limited\nmax_steps: 1\ninitial_step: first\nsteps:\n  - name: first\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: second\n  - name: second\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
      const cycles = [false, true, false].map((ignore) => ({ ignore, override: undefined as boolean | undefined }));
      if (settings === 'global ignore_exceed') cycles.push({ ignore: false, override: false }, { ignore: true, override: undefined });
      for (const { ignore, override } of cycles) {
        if (settings === 'project') {
          writeFileSync(join(project, '.takt', 'config.yaml'), `provider: mock\nlanguage: en\nconcurrency: 3\nignore_exceed: ${ignore}\n`);
        } else {
          writeFileSync(join(directory, 'config.yaml'), globalBase + `concurrency: 3\nignore_exceed: ${override === undefined ? ignore : true}\n`);
          writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n'
            + (override === undefined ? '' : `ignore_exceed: ${override}\n`));
        }
        const task = runner.addTask(`iteration bound ${ignore}`, { workflow: 'limited', worktree: false, goal_id: goal.id });
        await vi.waitFor(() => {
          const saved = runner.listTaskStateItems().find((item) => item.name === task.name)!;
          expect(saved.status).toBe(ignore ? 'completed' : 'exceeded');
          expect(saved.completion).toMatchObject({ success: ignore, interrupted: false,
            workflowResult: ignore ? 'completed' : 'exceeded' });
          expect(getProjectExecutionOwner(project)).toBeUndefined();
        }, { timeout: 30_000 });
        expect(Number(readFileSync(join(project, 'entered-iteration'), 'utf8'))).toBe(childPid);
      }
    }
  } finally {
    writeFileSync(join(project, 'release-worker'), 'cleanup');
    controller.abort();
    await daemon?.close();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(project, { recursive: true, force: true });
  }
});

it('executes a saved PR merge task through the daemon and persists its completion on builtin', async () => {
  const directory = getGlobalConfigDir();
  const project = mkdtempSync(join(directory, 'pool-pr-execution-'));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const controller = new AbortController();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--initial-branch=main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture');
    const record = goalRecord();
    git('branch', record.branch);
    const sha = git('rev-parse', 'HEAD');
    const remote = join(project, 'remote.git');
    git('clone', '--bare', project, remote);
    git('remote', 'add', 'origin', 'git@github.com:example/project.git');
    const gitConfig = join(project, 'gitconfig');
    writeFileSync(gitConfig, `[url "file://${remote}"]\n  insteadOf = git@github.com:example/project.git\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    writeFileSync(join(directory, 'config.yaml'), `provider: mock\nworktree_dir: ${JSON.stringify(join(project, 'clones'))}\ndaemon:\n  builtin_worker:\n    concurrency: 1\n`);
    invalidateGlobalConfigCache();
    mkdirSync(join(project, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\n');
    writeFileSync(join(project, '.takt', 'workflows', 'pool-merge.yaml'), 'name: pool-merge\ninitial_step: done\nsteps:\n  - name: done\n    mode: system\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const prUrl = 'https://github.com/example/project/pull/42';
    const goal = await new GoalStore(project).create({ ...record, status: 'awaiting_merge',
      pullRequest: { number: 42, url: prUrl }, completion: { goalBranch: record.branch, goalSha: sha,
        targetBranch: record.integrationBranch, summary: 'ready', instructions: [],
        changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false } },
    });
    const runner = new TaskRunner(project);
    const task = runner.enqueuePrMergeTask({ goalId: goal.id, prNumber: 42, prUrl,
      headBranch: goal.branch, baseBranch: goal.integrationBranch, headSha: sha,
      headRepositoryUrl: remote, headRepositoryPushUrls: [remote], method: 'squash', workflow: 'pool-merge',
      worktreePath: join(project, 'clones', 'merge'), threatCheckMaxDiffBytes: 1024,
    });
    const hook = join(project, 'github-hook.mjs');
    writeFileSync(hook, `
import { GitHubProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/infra/github/GitHubProvider.ts')).href)};
GitHubProvider.prototype.checkCliStatus = () => ({ available: true });
GitHubProvider.prototype.fetchPrDetails = async () => (${JSON.stringify({ number: 42, headBranch: goal.branch,
      baseBranch: goal.integrationBranch, headSha: sha, headRepositoryUrl: remote, headRepositoryPushUrls: [remote], sameRepository: true })});
GitHubProvider.prototype.fetchPrStatus = async () => ({ merged: true, headSha: ${JSON.stringify(sha)} });
`);
    vi.stubEnv('NODE_OPTIONS', `--import ${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))} --import ${JSON.stringify(pathToFileURL(hook).href)}`);
    const command = new AsyncCommand();
    const executeCommand = command.run.bind(command);
    vi.spyOn(AsyncCommand.prototype, 'run').mockImplementation(async (request, options) => {
      if (request.executable !== 'gh') return executeCommand(request, options);
      return { code: 0, signal: null, truncated: false, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({
        number: 42, url: prUrl, state: 'OPEN', headRefName: goal.branch, baseRefName: goal.integrationBranch, mergeable: 'MERGEABLE',
      })) };
    });
    await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
    const identity = getSelfProcessIdentity();
    if (identity === undefined) throw new Error('Test process identity unavailable');
    const owner = { pid: process.pid, identity, version: packageVersion, cliPath: daemonEntryPath() };
    await writeDaemonOwner(directory, owner);
    const turns = new ControlledTurnRunner();
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { turns.bus = bus; return turns; },
    });
    await vi.waitFor(() => {
      const saved = runner.listTaskStateItems().find((item) => item.name === task.name)!;
      expect(saved, JSON.stringify(saved)).toMatchObject({ status: 'completed', mergeTask: true, workerName: 'builtin',
        completion: { success: true, mergeOutcome: 'merged' }, runSlug: expect.any(String) });
    }, { timeout: 20_000 });
    const saved = new TaskStore(project).read().tasks[0]!;
    expect(saved.worker_name).toBe('builtin');
    expect(saved.owner_pid).toBeNull();
    expect(getTaktRun({ cwd: project, runSlug: saved.run_slug! }).isError).toBeUndefined();
  } finally {
    controller.abort();
    await daemon?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    rmSync(project, { recursive: true, force: true });
  }
});
