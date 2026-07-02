import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer } from '../app/mcp/server.js';

const SOURCE_STDIO_ENTRYPOINT_RUNNER = 'src/__tests__/helpers/mcp-source-stdio-entrypoint.ts';

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
          required: expect.arrayContaining(['cwd', 'task']),
        }),
      }));
      expect(toolsByName.get('takt_create_issue_and_enqueue_task')?.inputSchema.properties).toEqual(
        expect.objectContaining({
          labels: expect.any(Object),
        }),
      );
      expect(toolsByName.get('takt_run_next_task')?.inputSchema.required).toEqual(['cwd']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('Given the source MCP entrypoint, When a stdio MCP client lists and calls tools, Then stdout remains valid MCP protocol', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-stdio-'));
    const client = new Client({ name: 'takt-mcp-stdio-test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        'node_modules/.bin/vite-node',
        '--script',
        SOURCE_STDIO_ENTRYPOINT_RUNNER,
      ],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const stderrChunks: Buffer[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const result = await client.callTool({
        name: 'takt_run_next_task',
        arguments: { cwd },
      });

      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'takt_create_issue_and_enqueue_task',
        'takt_enqueue_task',
        'takt_run_next_task',
      ]);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(String(result.content[0]?.text))).toEqual({
        ran: false,
        message: 'No pending tasks in .takt/tasks.yaml',
      });
      expect(Buffer.concat(stderrChunks).toString('utf-8')).toBe('');
    } finally {
      await client.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Given an MCP client connection, When tools are called with root arguments, Then arguments reach TAKT operations', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260702-add-mcp',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
    });
    const task = {
      name: '20260702-add-mcp',
      content: 'Task: 20260702-add-mcp',
      filePath: '/repo/.takt/tasks/20260702-add-mcp.yaml',
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
          cwd: '/repo',
          task: 'Implement MCP support',
          workflow: 'review',
        },
      });
      await client.callTool({
        name: 'takt_create_issue_and_enqueue_task',
        arguments: {
          cwd: '/repo',
          task: 'Implement MCP support',
          labels: ['enhancement'],
        },
      });
      await client.callTool({
        name: 'takt_run_next_task',
        arguments: {
          cwd: '/repo',
          provider: 'mock',
          model: 'mock-model',
        },
      });

      expect(saveTaskFile).toHaveBeenNthCalledWith(1, '/repo', 'Implement MCP support', {
        workflow: 'review',
        worktree: true,
        autoPr: false,
      });
      expect(createIssueFromTaskResult).toHaveBeenCalledWith('Implement MCP support', expect.objectContaining({
        cwd: '/repo',
        labels: ['enhancement'],
        outputMode: 'silent',
      }));
      expect(saveTaskFile).toHaveBeenNthCalledWith(2, '/repo', 'Implement MCP support', {
        workflow: 'default',
        worktree: true,
        autoPr: false,
        issue: 938,
      });
      expect(createTaskRunner).toHaveBeenCalledWith('/repo');
      expect(executeRunTaskAndCompleteWithDetails).toHaveBeenCalledWith(
        task,
        taskRunner,
        '/repo',
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
