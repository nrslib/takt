import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { daemonEntryPath } from '../features/daemon/lifecycle.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { AsyncCommand } from '../infra/daemon/command.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getSelfProcessIdentity } from '../infra/task/process.js';
import { packageVersion } from '../shared/package-info.js';
import { ControlledTurnRunner } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

it.each([false, true])('keeps mergeTask=%s pending and exposes its waiting reason through the real daemon', async (mergeTask) => {
  const directory = getGlobalConfigDir();
  const project = mkdtempSync(join(directory, 'worker-pool-project-'));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const controller = new AbortController();
  try {
    writeFileSync(join(directory, 'config.yaml'), 'provider: mock\ndaemon:\n  builtin_worker:\n    concurrency: 0\n');
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nconcurrency: 3\n');
    const record = goalRecord();
    const prUrl = 'https://github.com/example/project/pull/42';
    const headSha = 'a'.repeat(40);
    const goal = await new GoalStore(project).create(mergeTask ? {
      ...record, status: 'awaiting_merge', pullRequest: { number: 42, url: prUrl },
      completion: { goalBranch: record.branch, goalSha: headSha, targetBranch: record.integrationBranch,
        summary: 'Ready for merge', instructions: [], changeSummary: {
          filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false,
        } },
    } : record);
    const runner = new TaskRunner(project);
    const task = mergeTask ? runner.enqueuePrMergeTask({ goalId: goal.id, prNumber: 42, prUrl,
      headBranch: goal.branch, baseBranch: goal.integrationBranch, headSha,
      headRepositoryUrl: project, headRepositoryPushUrls: [project],
      method: 'squash', workflow: 'merge-review-fix-simple',
      worktreePath: join(project, 'merge-clone'), threatCheckMaxDiffBytes: 1024,
    }) : runner.addTask('pending goal work', { goal_id: goal.id, worktree: false });
    const command = new AsyncCommand();
    const executeCommand = command.run.bind(command);
    vi.spyOn(AsyncCommand.prototype, 'run').mockImplementation(async (request, options) => {
      if (request.executable !== 'gh') return executeCommand(request, options);
      options.signal.throwIfAborted();
      return { code: 0, signal: null, truncated: false, stderr: Buffer.alloc(0),
        stdout: Buffer.from(JSON.stringify({ number: 42, url: prUrl, state: 'OPEN',
          headRefName: goal.branch, baseRefName: goal.integrationBranch, mergeable: 'MERGEABLE' })),
      };
    });
    await registerProject({ globalConfigDirectory: directory, projectDirectory: project, command: 'manager', managerUsed: true });
    const identity = getSelfProcessIdentity();
    if (identity === undefined) throw new Error('Test process identity is unavailable');
    const owner = { pid: process.pid, identity, version: packageVersion, cliPath: daemonEntryPath() };
    await writeDaemonOwner(directory, owner);
    const turns = new ControlledTurnRunner();
    daemon = await startDaemon({ configDirectory: directory, owner, tokens: undefined, signal: controller.signal,
      runnerFactory(bus) { turns.bus = bus; return turns; },
    });

    await vi.waitFor(async () => {
      const response = await listTaktTasks({ cwd: project });
      expect(response.isError).toBeUndefined();
      const output = JSON.parse(firstTextContent(response.content)) as { tasks: Record<string, unknown>[] };
      expect(output.tasks).toEqual([expect.objectContaining({ name: task.name, status: 'pending',
        waitingReason: expect.stringMatching(/no executable worker.*available/i),
      })]);
    }, { timeout: 10_000 });
    const saved = new TaskStore(project).read().tasks[0]!;
    expect(saved).toMatchObject({ status: 'pending', started_at: null, completed_at: null });
    expect(saved.owner_pid == null).toBe(true);
    expect(saved).not.toHaveProperty('execution_id');
    expect(saved).not.toHaveProperty('worker_name');
  } finally {
    controller.abort();
    await daemon?.close();
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  }
});
