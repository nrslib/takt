import { firstTextContent } from './helpers/mcp-content.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createTaktMcpServer } from '../app/mcp/server.js';
import type { SessionContext } from '../features/interactive/aiCaller.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';
import { getTaktRun, listTaktTasks } from '../features/mcp/operations.js';
import { resolveCloneBaseDir } from '../infra/task/index.js';
import { getCloneMetaPath } from '../infra/task/clone-meta.js';

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  readFileSyncMock.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: readFileSyncMock };
});


function writeRunFixture(
  baseCwd: string,
  runSlug: string,
  currentStep: string,
  reportContent = 'report',
): { runDir: string; interventionPath: string } {
  const runDir = join(baseCwd, '.takt', 'runs', runSlug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: runSlug,
    workflow: 'default',
    runSlug,
    runRoot: `.takt/runs/${runSlug}`,
    reportDirectory: `.takt/runs/${runSlug}/reports`,
    contextDirectory: `.takt/runs/${runSlug}/context`,
    logsDirectory: `.takt/runs/${runSlug}/logs`,
    status: 'running',
    startTime: '2026-09-09T00:00:00.000Z',
    currentStep,
  }), 'utf-8');
  writeFileSync(join(runDir, 'reports', '00-progress.md'), reportContent, 'utf-8');
  return {
    runDir,
    interventionPath: join(baseCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'),
  };
}

function writeCloneOwnershipMetadata(projectCwd: string, branch: string, clonePath: string): void {
  const metadataPath = getCloneMetaPath(projectCwd, branch);
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({ branch, clonePath }), 'utf-8');
}

describe('MCP package entrypoint', () => {
  it('declares the stdio binary and official MCP SDK', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(packageJson.bin?.['takt-mcp']).toBe('./dist/app/mcp/index.js');
    expect(packageJson.dependencies?.['@modelcontextprotocol/sdk']).toEqual(expect.any(String));
  });

  it('exports the stdio connector', async () => {
    const entrypoint = await import('../app/mcp/index.js') as {
      connectTaktMcpServerToStdio?: unknown;
    };
    expect(entrypoint.connectTaktMcpServerToStdio).toEqual(expect.any(Function));
  });

  it('exposes task enqueue, read, and tell tools with their public schemas', async () => {
    const server = createTaktMcpServer();
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'takt_enqueue_task',
        'takt_list_tasks',
        'takt_get_run',
        'takt_tell_run',
      ]));
      expect(tools.tools).toHaveLength(4);
      expect(tools.tools.find((tool) => tool.name === 'takt_enqueue_task')).toEqual(expect.objectContaining({
        title: 'Enqueue TAKT task',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'task', 'workflow', 'autoPr']),
          properties: expect.objectContaining({ issue: expect.any(Object) }),
        }),
      }));
      expect(tools.tools.find((tool) => tool.name === 'takt_list_tasks')).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd']),
          properties: expect.objectContaining({ cwd: expect.any(Object) }),
        }),
      }));
      expect(tools.tools.find((tool) => tool.name === 'takt_get_run')).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'runSlug']),
          properties: expect.objectContaining({
            cwd: expect.any(Object),
            runSlug: expect.any(Object),
          }),
        }),
      }));
      expect(tools.tools.find((tool) => tool.name === 'takt_tell_run')).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'runSlug', 'content']),
          properties: expect.objectContaining({
            cwd: expect.any(Object),
            runSlug: expect.any(Object),
            content: expect.any(Object),
          }),
        }),
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('can register the same server with read-only task-state tools', async () => {
    const server = createTaktMcpServer({}, { toolSet: 'read-only' });
    const client = new Client({ name: 'takt-mcp-read-only-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'takt_list_tasks',
        'takt_get_run',
      ]));
      expect(tools.tools).toHaveLength(2);
      const enqueueResult = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: { cwd: process.cwd(), task: 'must not enqueue', workflow: 'default', autoPr: false },
      });
      expect(enqueueResult.isError).toBe(true);
      expect(firstTextContent(enqueueResult.content)).toContain('Tool takt_enqueue_task not found');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a summary without report contents and returns selected run details', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-state-'));
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'authentication');
    const runSlug = 'auth-run';
    const reportMarker = 'REPORT_ONLY_IN_DETAILS';
    const runDir = join(cloneCwd, '.takt', 'runs', runSlug);
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    mkdirSync(join(runDir, 'reports'), { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'Implement authentication',
      workflow: 'review-fix',
      runSlug,
      runRoot: `.takt/runs/${runSlug}`,
      reportDirectory: `.takt/runs/${runSlug}/reports`,
      contextDirectory: `.takt/runs/${runSlug}/context`,
      logsDirectory: `.takt/runs/${runSlug}/logs`,
      status: 'running',
      startTime: '2026-09-09T00:00:00.000Z',
      currentStep: 'implement',
      phase: 2,
    }), 'utf-8');
    writeFileSync(join(runDir, 'logs', 'session-001.jsonl'), [
      JSON.stringify({
        type: 'workflow_start',
        task: 'Implement authentication',
        workflowName: 'review-fix',
        startTime: '2026-09-09T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        status: 'done',
        content: 'Plan is ready',
        instruction: 'Create a plan',
        timestamp: '2026-09-09T00:01:00.000Z',
      }),
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(runDir, 'reports', '00-progress.md'), reportMarker, 'utf-8');
    mkdirSync(join(cwd, '.takt', 'runs', runSlug), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'runs', runSlug, 'interventions.jsonl'), `${JSON.stringify({
      type: 'issued',
      instructionId: 1,
      issuedAt: '2026-09-09T00:02:00.000Z',
      content: 'Keep the existing session flow.',
    })}\n`, 'utf-8');
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'authentication',
        status: 'running',
        content_file: '/definitely-not-readable/task-spec.md',
        summary: 'Add login and session handling',
        workflow: 'review-fix',
        worktree: true,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
        worktree_path: cloneCwd,
      }],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-state-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listResult = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listResult.isError).toBeUndefined();
      const listPayload = JSON.parse(firstTextContent(listResult.content)) as {
        tasks: Array<Record<string, unknown>>;
      };
      const listedTask = listPayload.tasks.find((task) => task.name === 'authentication');
      expect(listedTask).toEqual(expect.objectContaining({
        name: 'authentication',
        summary: 'Add login and session handling',
        status: 'running',
        workflow: 'review-fix',
        currentStep: 'implement',
      }));
      expect(listedTask).not.toHaveProperty('stepLogs');
      expect(listedTask).not.toHaveProperty('reports');
      expect(firstTextContent(listResult.content)).not.toContain(reportMarker);

      const getResult = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug },
      });
      expect(getResult.isError).toBeUndefined();
      const getPayload = JSON.parse(firstTextContent(getResult.content)) as Record<string, unknown>;
      expect(getPayload).toEqual(expect.objectContaining({
        runSlug,
        currentStep: 'implement',
        phase: 2,
        stepLogs: expect.arrayContaining([
          expect.objectContaining({ step: 'plan', content: 'Plan is ready' }),
        ]),
        reports: expect.arrayContaining([
          expect.objectContaining({ filename: '00-progress.md', content: reportMarker }),
        ]),
        liveIntervention: expect.objectContaining({
          issuedTotal: 1,
          pending: 1,
          instructions: expect.arrayContaining([
            expect.objectContaining({
              instructionId: 1,
              content: 'Keep the existing session flow.',
              state: 'pending',
            }),
          ]),
        }),
      }));

      rmSync(join(runDir, 'meta.json'));
      const deletedRun = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug },
      });
      expect(deletedRun.isError).toBe(true);
      expect(firstTextContent(deletedRun.content)).toContain('Run read failed');

      const afterDeletedRun = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(afterDeletedRun.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(afterDeletedRun.content))).toEqual(expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ name: 'authentication', runSlug }),
        ]),
      }));
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a task worktree outside the project clone boundary', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-boundary-'));
    const externalCwd = mkdtempSync(join(cwd, '..', 'takt-mcp-external-'));
    const runSlug = 'external-run';
    const runDir = join(externalCwd, '.takt', 'runs', runSlug);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'External task',
      workflow: 'external-workflow',
      runSlug,
      runRoot: `.takt/runs/${runSlug}`,
      status: 'running',
      currentStep: 'external-step',
      startTime: '2026-09-09T00:00:00.000Z',
    }), 'utf-8');
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'untrusted-task',
        status: 'running',
        content: 'Task with an untrusted worktree path',
        workflow: 'project-workflow',
        worktree: true,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
        worktree_path: externalCwd,
      }],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-boundary-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toContain('Task list failed');
      expect(firstTextContent(result.content)).not.toContain('external-workflow');
      expect(firstTextContent(result.content)).not.toContain('external-step');
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(externalCwd, { recursive: true, force: true });
    }
  });

  it('rejects an unowned clone in a shared root for list, get, and tell', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-owner-project-'));
    const otherProject = mkdtempSync(join(tmpdir(), 'takt-mcp-owner-other-'));
    const cloneBase = resolveCloneBaseDir(cwd);
    mkdirSync(cloneBase, { recursive: true });
    const sharedRoot = mkdtempSync(join(cloneBase, 'takt-mcp-owner-shared-'));
    const ownedClone = join(sharedRoot, 'owned');
    const unownedClone = join(sharedRoot, 'unowned');
    const ownedSlug = 'owned-run';
    const unownedSlug = 'unowned-run';
    const ownedBranch = 'takt/owned';
    const unownedBranch = 'takt/unowned';
    mkdirSync(ownedClone, { recursive: true });
    mkdirSync(unownedClone, { recursive: true });
    writeRunFixture(ownedClone, ownedSlug, 'owned-step', 'OWNED_REPORT');
    writeRunFixture(unownedClone, unownedSlug, 'unowned-step', 'UNOWNED_REPORT_SECRET');
    writeCloneOwnershipMetadata(cwd, ownedBranch, ownedClone);
    // The same metadata in another project must not grant project A access.
    writeCloneOwnershipMetadata(otherProject, unownedBranch, unownedClone);
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [
        {
          name: 'owned-task',
          status: 'running',
          content: 'Owned task',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          branch: ownedBranch,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: ownedSlug,
          worktree_path: ownedClone,
        },
        {
          name: 'unowned-task',
          status: 'running',
          content: 'Unowned task',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          branch: unownedBranch,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: unownedSlug,
          worktree_path: unownedClone,
        },
      ],
    }), 'utf-8');
    const unownedInterventionPath = join(cwd, '.takt', 'runs', unownedSlug, 'interventions.jsonl');
    mkdirSync(join(cwd, '.takt', 'runs', unownedSlug), { recursive: true });
    const unchangedIntervention = `${JSON.stringify({
      type: 'issued',
      instructionId: 1,
      issuedAt: '2026-09-09T00:00:00.000Z',
      content: 'original',
    })}\n`;
    writeFileSync(unownedInterventionPath, unchangedIntervention, 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-owner-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listed.isError).toBe(true);
      expect(firstTextContent(listed.content)).not.toContain('UNOWNED_REPORT_SECRET');
      expect(firstTextContent(listed.content)).not.toContain('unowned-step');

      const owned = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug: ownedSlug },
      });
      expect(owned.isError).toBeUndefined();
      expect(firstTextContent(owned.content)).toContain('OWNED_REPORT');

      const unowned = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug: unownedSlug },
      });
      expect(unowned.isError).toBe(true);
      expect(firstTextContent(unowned.content)).not.toContain('UNOWNED_REPORT_SECRET');
      expect(firstTextContent(unowned.content)).not.toContain('unowned-step');

      const ownedTell = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug: ownedSlug, content: 'update the owned task' },
      });
      expect(ownedTell.isError).toBeUndefined();
      expect(readFileSync(join(cwd, '.takt', 'runs', ownedSlug, 'interventions.jsonl'), 'utf-8'))
        .toContain('update the owned task');

      const unownedTell = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug: unownedSlug, content: 'must not be written' },
      });
      expect(unownedTell.isError).toBe(true);
      expect(readFileSync(unownedInterventionPath, 'utf-8')).toBe(unchangedIntervention);
      expect(existsSync(join(unownedClone, '.takt', 'runs', unownedSlug, 'interventions.jsonl'))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      rmSync(sharedRoot, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it('does not resolve an external content_file for MCP list or tell when summary is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-summary-project-'));
    const contentRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-summary-content-'));
    const contentPath = join(contentRoot, 'secret-task.md');
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'active');
    const runSlug = 'summary-run';
    const secret = 'EXTERNAL_CONTENT_SECRET';
    writeFileSync(contentPath, `${secret}\nprivate details`, 'utf-8');
    mkdirSync(cloneCwd, { recursive: true });
    writeRunFixture(cloneCwd, runSlug, 'implement');
    mkdirSync(join(cwd, '.takt', 'runs', runSlug), { recursive: true });
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'summary-less-task',
        status: 'running',
        content_file: contentPath,
        workflow: 'default',
        worktree: true,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
        worktree_path: cloneCwd,
      }],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-summary-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    readFileSyncMock.mockClear();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listed.isError).toBeUndefined();
      const listedText = firstTextContent(listed.content);
      const listedTask = (JSON.parse(listedText) as { tasks: Array<Record<string, unknown>> }).tasks[0];
      expect(listedTask).not.toHaveProperty('summary');
      expect(listedText).not.toContain(secret);

      const told = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug, content: 'keep the task focused' },
      });
      expect(told.isError).toBeUndefined();
      const toldText = firstTextContent(told.content);
      expect((JSON.parse(toldText) as { target: Record<string, unknown> }).target)
        .not.toHaveProperty('summary');
      expect(toldText).not.toContain(secret);
      expect(readFileSyncMock.mock.calls.filter(([filePath]) => filePath === contentPath)).toHaveLength(0);
      expect(readFileSync(contentPath, 'utf-8')).toContain(secret);
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(contentRoot, { recursive: true, force: true });
    }
  });

  it('keeps the same conversation alive after a deleted run read fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-conversation-recovery-'));
    const runSlug = 'recoverable-run';
    const runDir = join(cwd, '.takt', 'runs', runSlug);
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    mkdirSync(join(runDir, 'reports'), { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'Recoverable task',
      workflow: 'default',
      runSlug,
      runRoot: `.takt/runs/${runSlug}`,
      reportDirectory: `.takt/runs/${runSlug}/reports`,
      contextDirectory: `.takt/runs/${runSlug}/context`,
      logsDirectory: `.takt/runs/${runSlug}/logs`,
      status: 'running',
      startTime: '2026-09-09T00:00:00.000Z',
      currentStep: 'implement',
    }), 'utf8');
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'recoverable-task',
        status: 'running',
        content: 'Recoverable task',
        summary: 'A task whose run may disappear',
        workflow: 'default',
        worktree: false,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
      }],
    }), 'utf8');

    const calls: Array<{ prompt: string; sessionId: string | undefined }> = [];
    let turn = 0;
    const provider = {
      supportsNativeImageInput: false,
      getRuntimeInstructions: () => null,
      setup: vi.fn(() => ({
        call: async (prompt: string, options: { sessionId?: string }) => {
          calls.push({ prompt, sessionId: options.sessionId });
          turn += 1;
          if (turn === 1) {
            const result = getTaktRun({ cwd, runSlug });
            return {
              persona: 'interactive',
              status: 'done' as const,
              content: `Initial task state: ${firstTextContent(result.content)}`,
              timestamp: new Date(),
              sessionId: 'conversation-session',
            };
          }
          if (turn === 2) {
            const result = getTaktRun({ cwd, runSlug });
            return {
              persona: 'interactive',
              status: 'done' as const,
              content: `The task state could not be read: ${firstTextContent(result.content)}`,
              timestamp: new Date(),
              sessionId: 'conversation-session',
            };
          }
          const result = listTaktTasks({ cwd });
          return {
            persona: 'interactive',
            status: 'done' as const,
            content: `The task list is still available: ${firstTextContent(result.content)}`,
            timestamp: new Date(),
            sessionId: 'conversation-session',
          };
        },
      })),
    } as unknown as SessionContext['provider'];
    const ctx: SessionContext = {
      provider,
      providerType: 'mock',
      model: 'test-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };
    const conversation = createConversationSession({
      cwd,
      formalSpec: false,
      ctx,
      strategy: {
        systemPrompt: 'system',
        allowedTools: [],
        transformPrompt: (message) => message,
      },
    });

    try {
      const initial = await conversation.handleUserMessage({ text: 'show the run details' });
      expect(initial).toMatchObject({
        kind: 'assistant_response',
        content: expect.stringContaining('currentStep'),
      });

      rmSync(join(runDir, 'meta.json'));
      const afterDeletion = await conversation.handleUserMessage({ text: 'check that run again' });
      expect(afterDeletion).toMatchObject({
        kind: 'assistant_response',
        content: expect.stringContaining('Run read failed'),
      });

      const afterFailure = await conversation.handleUserMessage({ text: 'list the remaining tasks' });
      expect(afterFailure).toMatchObject({
        kind: 'assistant_response',
        content: expect.stringContaining('recoverable-task'),
      });
      expect(calls).toHaveLength(3);
      expect(calls[1]?.sessionId).toBe('conversation-session');
      expect(calls[2]?.sessionId).toBe('conversation-session');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('writes only to a running clone and rejects terminal, missing, and non-clone targets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-tell-'));
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'active');
    const activeSlug = 'active-run';
    const nonCloneSlug = 'local-run';
    const mismatchSlug = 'mismatch-run';
    const writeRunMeta = (
      baseCwd: string,
      slug: string,
      status: 'running' | 'completed',
      persistedSlug = slug,
    ): string => {
      const runDir = join(baseCwd, '.takt', 'runs', slug);
      mkdirSync(join(runDir, 'logs'), { recursive: true });
      mkdirSync(join(runDir, 'reports'), { recursive: true });
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
        task: slug,
        workflow: 'default',
        runSlug: persistedSlug,
        runRoot: `.takt/runs/${slug}`,
        reportDirectory: `.takt/runs/${slug}/reports`,
        contextDirectory: `.takt/runs/${slug}/context`,
        logsDirectory: `.takt/runs/${slug}/logs`,
        status,
        startTime: '2026-09-09T00:00:00.000Z',
        currentStep: 'implement',
      }), 'utf-8');
      return runDir;
    };
    const activeRunDir = writeRunMeta(cloneCwd, activeSlug, 'running');
    writeRunMeta(cwd, nonCloneSlug, 'running');
    writeRunMeta(cloneCwd, mismatchSlug, 'running', 'different-slug');
    mkdirSync(join(cwd, '.takt', 'runs'), { recursive: true });
    const interventionPath = join(cwd, '.takt', 'runs', activeSlug, 'interventions.jsonl');
    mkdirSync(join(cwd, '.takt', 'runs', activeSlug), { recursive: true });
    writeFileSync(interventionPath, `${JSON.stringify({
      type: 'issued',
      instructionId: 1,
      issuedAt: '2026-09-09T00:00:30.000Z',
      content: 'Keep the existing session flow.',
    })}\n`, 'utf-8');
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [
        {
          name: 'active',
          status: 'running',
          content_file: '/definitely-not-readable/active-task.md',
          summary: 'Active task summary',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: activeSlug,
          worktree_path: cloneCwd,
        },
        {
          name: 'non-clone',
          status: 'running',
          content: 'Non-clone task',
          workflow: 'default',
          worktree: false,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: nonCloneSlug,
        },
        {
          name: 'mismatch',
          status: 'running',
          content: 'Mismatched task',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: mismatchSlug,
          worktree_path: cloneCwd,
        },
      ],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-tell-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const written = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug: activeSlug, content: 'Skip Android support for this task.' },
      });
      expect(written.isError).toBeUndefined();
      expect(firstTextContent(written.content)).toContain(activeSlug);
      const writtenEvents = readFileSync(interventionPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { instructionId: number; content: string });
      expect(writtenEvents).toEqual([
        expect.objectContaining({ instructionId: 1, content: 'Keep the existing session flow.' }),
        expect.objectContaining({ instructionId: 2, content: 'Skip Android support for this task.' }),
      ]);

      writeFileSync(join(activeRunDir, 'meta.json'), JSON.stringify({
        task: 'active',
        workflow: 'default',
        runSlug: activeSlug,
        runRoot: `.takt/runs/${activeSlug}`,
        reportDirectory: `.takt/runs/${activeSlug}/reports`,
        contextDirectory: `.takt/runs/${activeSlug}/context`,
        logsDirectory: `.takt/runs/${activeSlug}/logs`,
        status: 'completed',
        startTime: '2026-09-09T00:00:00.000Z',
        endTime: '2026-09-09T00:02:00.000Z',
      }), 'utf-8');
      const beforeRejectedWrites = readFileSync(interventionPath, 'utf-8');

      for (const [runSlug, reason] of [
        [activeSlug, 'completed'],
        ['missing-run', 'missing'],
        [nonCloneSlug, 'clone'],
        [mismatchSlug, 'slug'],
      ] as const) {
        const rejected = await client.callTool({
          name: 'takt_tell_run',
          arguments: { cwd, runSlug, content: `must reject ${reason}` },
        });
        expect(rejected.isError).toBe(true);
        expect(firstTextContent(rejected.content).toLowerCase()).toContain(reason);
      }
      expect(readFileSync(interventionPath, 'utf-8')).toBe(beforeRejectedWrites);
      expect(existsSync(join(cwd, '.takt', 'runs', nonCloneSlug, 'interventions.jsonl'))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('routes normal, existing-issue, and create-issue calls through the single tool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-root-'));
    const saveTaskFile = vi.fn()
      .mockResolvedValueOnce({ taskName: 'normal', tasksFile: join(cwd, '.takt', 'tasks.yaml') })
      .mockResolvedValueOnce({ taskName: 'existing', tasksFile: join(cwd, '.takt', 'tasks.yaml') })
      .mockResolvedValueOnce({ taskName: 'created', tasksFile: join(cwd, '.takt', 'tasks.yaml') });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
    });
    const server = createTaktMcpServer(
      { saveTaskFile, createIssueFromTaskResult },
      { allowedProjectRoot: cwd },
    );
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: 'takt_enqueue_task',
        arguments: { cwd, task: 'Normal', workflow: 'default', autoPr: false },
      });
      await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Existing',
          workflow: 'default',
          autoPr: false,
          issue: { number: 937 },
        },
      });
      const created = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Created',
          workflow: 'default',
          autoPr: false,
          issue: { create: true, title: 'Explicit title', labels: ['mcp'] },
        },
      });
      expect(created.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(created.content))).toEqual(expect.objectContaining({
        issueNumber: 938,
      }));
      expect(saveTaskFile).toHaveBeenCalledTimes(3);
      expect(saveTaskFile).toHaveBeenNthCalledWith(2, cwd, 'Existing', {
        workflow: 'default',
        worktree: true,
        autoPr: false,
        issue: 937,
      }, undefined, expect.any(AbortSignal));
      expect(createIssueFromTaskResult).toHaveBeenCalledWith('Created', expect.objectContaining({
        explicitTitle: 'Explicit title',
        labels: ['mcp'],
      }));
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns a structured partial-success result through a real MCP client', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-partial-'));
    const server = createTaktMcpServer({
      saveTaskFile: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
      createIssueFromTaskResult: vi.fn().mockReturnValue({
        success: true,
        issueNumber: 938,
        issueUrl: 'https://example.test/issues/938',
      }),
    }, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Created',
          workflow: 'default',
          autoPr: false,
          issue: { create: true },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(firstTextContent(result.content))).toEqual({
        issueCreated: true,
        issueNumber: 938,
        issueUrl: 'https://example.test/issues/938',
        taskEnqueued: false,
        stage: 'task_saving',
        error: 'permission denied',
      });
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects removed tools and invalid nested issue shapes before saving', async () => {
    const saveTaskFile = vi.fn();
    const server = createTaktMcpServer({ saveTaskFile });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const removed = await client.callTool({
        name: 'takt_run_next_task',
        arguments: { cwd: '/repo' },
      });
      expect(removed.isError).toBe(true);
      expect(firstTextContent(removed.content)).toContain('not found');
      const invalid = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd: '/repo',
          task: 'Invalid',
          workflow: 'default',
          autoPr: false,
          issue: { number: 938, create: true },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(saveTaskFile).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
