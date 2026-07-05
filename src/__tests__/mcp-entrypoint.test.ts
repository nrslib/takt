import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer } from '../app/mcp/server.js';

function objectProperties(schema: unknown): Record<string, Record<string, unknown>> {
  const value = schema as { properties?: Record<string, Record<string, unknown>> };
  return value.properties ?? {};
}

describe('MCP package entrypoint', () => {
  it('Given package metadata, When bin entries are read, Then takt-mcp points at the stdio MCP entrypoint', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin).toEqual(expect.objectContaining({
      'takt-mcp': './dist/app/mcp/index.js',
    }));
  });

  it('Given package metadata, When dependencies are read, Then the official MCP TypeScript SDK is declared', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual(expect.objectContaining({
      '@modelcontextprotocol/sdk': expect.any(String),
    }));
  });

  it('Given the source entrypoint, When it is imported, Then it exports the stdio connector function', async () => {
    const mcpEntrypoint = await import('../app/mcp/index.js') as {
      connectTaktMcpServerToStdio?: unknown;
    };

    expect(mcpEntrypoint.connectTaktMcpServerToStdio).toEqual(expect.any(Function));
  });

  it('Given an MCP client connection, When tools are listed, Then TAKT tools and schemas are exposed', async () => {
    const server = createTaktMcpServer();
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerVersion()).toEqual({
        name: 'takt',
        version: packageJson.version,
      });

      const tools = await client.listTools();
      const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));

      expect([...toolsByName.keys()].sort()).toEqual([
        'takt_create_issue_and_enqueue_task',
        'takt_enqueue_task',
        'takt_run_next_task',
      ]);
      expect(toolsByName.get('takt_enqueue_task')).toEqual(expect.objectContaining({
        title: 'Enqueue TAKT task',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'task', 'workflow', 'autoPr']),
        }),
      }));
      expect(toolsByName.get('takt_create_issue_and_enqueue_task')?.inputSchema.properties).toEqual(
        expect.objectContaining({
          labels: expect.any(Object),
        }),
      );
      expect(toolsByName.get('takt_run_next_task')?.inputSchema.required).toEqual(['cwd']);

      const enqueueProperties = objectProperties(toolsByName.get('takt_enqueue_task')?.inputSchema);
      const issueProperties = objectProperties(toolsByName.get('takt_create_issue_and_enqueue_task')?.inputSchema);
      const runNextProperties = objectProperties(toolsByName.get('takt_run_next_task')?.inputSchema);
      const enqueueTaskContext = objectProperties(enqueueProperties.taskContext);
      const runNextTaskContext = objectProperties(runNextProperties.taskContext);

      expect(enqueueProperties.workflow?.description).toBe('Workflow identifier to store on the queued task. Ask the user which workflow to use before enqueueing.');
      expect(enqueueProperties.worktree?.description).toBe('Whether the queued task should run in a TAKT-managed worktree.');
      expect(enqueueProperties.autoPr?.description).toBe('Whether successful worktree execution should automatically open a pull request. Ask the user before enqueueing.');
      expect(issueProperties.labels?.description).toBe('Issue labels to request from the configured issue provider.');
      expect(runNextProperties.provider?.description).toBe('Agent provider override for this task execution.');
      expect(runNextProperties.model?.description).toBe('Model override for this task execution.');
      expect(enqueueTaskContext.branch?.description).toBe('Plain local Git branch name for task execution context.');
      expect(enqueueTaskContext.baseBranch?.description).toBe('Plain local Git base branch name used when creating or resolving a task worktree.');
      expect(enqueueTaskContext.baseBranch?.description).not.toBe(enqueueTaskContext.branch?.description);
      expect(runNextTaskContext.prNumber?.description).toBe('PR number used as task execution context, not as PR-review provenance.');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('Given an MCP client connection, When tools are called with root arguments, Then arguments reach TAKT operations', async () => {
    const cwd = mkdtempSync(join(process.cwd(), '.tmp-takt-mcp-root-'));
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260702-add-mcp',
      tasksFile: join(cwd, '.takt', 'tasks.yaml'),
    });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
    });
    const task = {
      name: '20260702-add-mcp',
      content: 'Task: 20260702-add-mcp',
      filePath: join(cwd, '.takt', 'tasks', '20260702-add-mcp.yaml'),
      createdAt: '2026-07-02T00:00:00.000Z',
      status: 'running',
      data: {
        task: 'Task: 20260702-add-mcp',
        workflow: 'default',
      },
    };
    const taskRunner = {
      failInterruptedRunningTasks: vi.fn(() => 0),
      claimNextTasks: vi.fn(() => [task]),
    };
    const createTaskRunner = vi.fn(() => taskRunner);
    const executeRunTaskAndCompleteWithDetails = vi.fn().mockResolvedValue({ success: true });
    const server = createTaktMcpServer({
      saveTaskFile,
      createIssueFromTaskResult,
      createTaskRunner,
      executeRunTaskAndCompleteWithDetails,
    });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Implement MCP support',
          workflow: 'review',
          autoPr: false,
        },
      });
      await client.callTool({
        name: 'takt_create_issue_and_enqueue_task',
        arguments: {
          cwd,
          task: 'Implement MCP support',
          workflow: 'default',
          autoPr: false,
          labels: ['enhancement'],
        },
      });
      await client.callTool({
        name: 'takt_run_next_task',
        arguments: {
          cwd,
          provider: 'mock',
          model: 'mock-model',
        },
      });

      expect(saveTaskFile).toHaveBeenNthCalledWith(1, cwd, 'Implement MCP support', {
        workflow: 'review',
        worktree: true,
        autoPr: false,
      });
      expect(createIssueFromTaskResult).toHaveBeenCalledWith('Implement MCP support', expect.objectContaining({
        cwd,
        labels: ['enhancement'],
        outputMode: 'silent',
      }));
      expect(saveTaskFile).toHaveBeenNthCalledWith(2, cwd, 'Implement MCP support', {
        workflow: 'default',
        worktree: true,
        autoPr: false,
        issue: 938,
      });
      expect(createTaskRunner).toHaveBeenCalledWith(cwd);
      expect(executeRunTaskAndCompleteWithDetails).toHaveBeenCalledWith(
        task,
        taskRunner,
        cwd,
        {
          provider: 'mock',
          model: 'mock-model',
        },
        expect.objectContaining({
          outputMode: 'silent',
        }),
        expect.objectContaining({
          gitProvider: expect.any(Object),
        }),
      );
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given a cwd outside the MCP server root, When a tool is called, Then the operation is rejected before saving', async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-allowed-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-outside-'));
    const saveTaskFile = vi.fn();
    const server = createTaktMcpServer({ saveTaskFile }, { allowedProjectRoot: allowedRoot });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd: outsideRoot,
          task: 'Implement MCP support',
          workflow: 'default',
          autoPr: false,
        },
      });

      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toContain('outside the allowed project root');
      expect(saveTaskFile).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('Given an MCP client connection, When response-envelope input is sent, Then the tool call is rejected before operations run', async () => {
    const saveTaskFile = vi.fn();
    const server = createTaktMcpServer({ saveTaskFile });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              cwd: '/repo',
              task: 'Implement MCP support',
            }),
          }],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          text: expect.stringMatching(/cwd|task/i),
        }),
      ]);
      expect(saveTaskFile).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
