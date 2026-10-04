import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env.js';
import { createTestRepo, isGitHubE2EAvailable, type TestRepo } from '../helpers/test-repo.js';
import { formatTaktRunResult, runTakt } from '../helpers/takt-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const requiresGitHub = isGitHubE2EAvailable();

// E2E更新時は docs/testing/e2e.md も更新すること
describe.skipIf(!requiresGitHub)('E2E: MCP enqueue -> task run -> non-draft PR', () => {
  let isolatedEnv: IsolatedEnv | undefined;
  let testRepo: TestRepo | undefined;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
    execFileSync('git', ['checkout', '-'], { cwd: testRepo.path, stdio: 'pipe' });
  });

  afterEach(() => {
    const cleanupErrors: unknown[] = [];
    if (testRepo !== undefined) {
      const repo = testRepo;
      try {
        const prNumbers = execFileSync('gh', [
          'pr', 'list', '--head', repo.branch, '--state', 'open',
          '--repo', repo.repoName, '--json', 'number', '--jq', '.[].number',
        ], { encoding: 'utf-8', stdio: 'pipe' }).trim();
        for (const number of prNumbers.split('\n').filter(Boolean)) {
          execFileSync('gh', ['pr', 'close', number, '--repo', repo.repoName], { stdio: 'pipe' });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        repo.cleanup();
        const openPrs = JSON.parse(execFileSync('gh', [
          'pr', 'list', '--head', repo.branch, '--state', 'open',
          '--repo', repo.repoName, '--json', 'number',
        ], { encoding: 'utf-8', stdio: 'pipe' }));
        expect(openPrs, 'Test PR cleanup').toEqual([]);
        const refs = JSON.parse(execFileSync('gh', [
          'api', `repos/${repo.repoName}/git/matching-refs/heads/${repo.branch}`,
        ], { encoding: 'utf-8', stdio: 'pipe' }));
        expect(refs, 'Test remote branch cleanup').toEqual([]);
        expect(existsSync(repo.path), 'Test repository cleanup').toBe(false);
        console.info('Task auto PR E2E cleanup', { branch: repo.branch, openPrs, refs, repositoryRemoved: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      testRepo = undefined;
    }
    try {
      isolatedEnv?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    isolatedEnv = undefined;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up task auto PR E2E resources');
    }
  });

  it('should create a non-draft PR for MCP draftPr false despite project draft_pr true', async () => {
    if (testRepo === undefined || isolatedEnv === undefined) {
      throw new Error('Task auto PR E2E resources are not initialized');
    }
    const repo = testRepo;
    const environment = isolatedEnv;
    const workflow = 'e2e-simple';
    const tasksFile = join(repo.path, '.takt', 'tasks.yaml');

    mkdirSync(join(repo.path, '.takt', 'workflows'), { recursive: true });
    copyFileSync(
      resolve(__dirname, '../fixtures/workflows/simple.yaml'),
      join(repo.path, '.takt', 'workflows', `${workflow}.yaml`),
    );
    writeFileSync(
      join(repo.path, '.takt', 'config.yaml'),
      'draft_pr: true\nbranch_name_strategy: romaji\n',
      'utf-8',
    );

    const client = new Client({ name: 'takt-task-auto-pr-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(__dirname, '../../dist/app/mcp/index.js')],
      cwd: repo.path,
      env: Object.fromEntries(
        Object.entries(environment.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      stderr: 'inherit',
    });
    let taskName: string;
    try {
      await client.connect(transport);
      const enqueued = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd: repo.path,
          task: 'Create a file called task-auto-pr.txt with the content "Task auto PR E2E"',
          workflow,
          worktree: true,
          autoPr: true,
          draftPr: false,
          taskContext: { branch: repo.branch },
        },
      });
      expect(enqueued.isError).toBeUndefined();
      const content = enqueued.content;
      if (!Array.isArray(content) || content[0]?.type !== 'text') {
        throw new Error('MCP enqueue response does not contain text');
      }
      const payload = JSON.parse(content[0].text) as { taskName: string };
      expect(payload).toEqual(expect.objectContaining({
        taskName: expect.any(String),
        tasksFile,
        workflow,
        worktree: true,
        autoPr: true,
        draftPr: false,
      }));
      taskName = payload.taskName;
      const stored = parseYaml(readFileSync(tasksFile, 'utf-8')) as { tasks: Array<Record<string, unknown>> };
      expect(stored.tasks).toHaveLength(1);
      expect(stored.tasks[0]).toEqual(expect.objectContaining({
        name: taskName,
        status: 'pending',
        workflow,
        branch: repo.branch,
        worktree: true,
        auto_pr: true,
        draft_pr: false,
      }));
    } finally {
      await client.close();
    }

    const result = runTakt({
      args: ['run'],
      cwd: repo.path,
      env: environment.env,
      timeout: 240_000,
    });

    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    const completed = parseYaml(readFileSync(tasksFile, 'utf-8')) as { tasks: Array<Record<string, unknown>> };
    expect(completed.tasks).toHaveLength(1);
    const task = completed.tasks[0];
    expect(task, formatTaktRunResult(result)).toEqual(expect.objectContaining({
      name: taskName,
      status: 'completed',
      branch: repo.branch,
      draft_pr: false,
      worktree_path: expect.any(String),
      pr_url: expect.any(String),
    }));
    if (typeof task?.worktree_path !== 'string') {
      throw new Error('Completed task has no worktree path');
    }
    expect(task.worktree_path).not.toBe(repo.path);
    expect(existsSync(task.worktree_path)).toBe(true);

    const prs = JSON.parse(execFileSync(
      'gh',
      ['pr', 'list', '--head', repo.branch, '--state', 'open', '--repo', repo.repoName, '--json', 'url,isDraft,headRefName'],
      { cwd: repo.path, encoding: 'utf-8', stdio: 'pipe' },
    ));
    expect(prs).toEqual([{
      url: task.pr_url,
      isDraft: false,
      headRefName: repo.branch,
    }]);
    console.info('Task auto PR E2E observation', {
      taskName,
      status: task.status,
      worktreePath: task.worktree_path,
      savedPrUrl: task.pr_url,
      prs,
    });
  }, 240_000);
});
