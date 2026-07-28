import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer } from '../app/mcp/server.js';

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

  it('exposes enqueue and read-only task listing tools', async () => {
    const server = createTaktMcpServer();
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['takt_enqueue_task', 'takt_list_tasks']);
      expect(tools.tools[0]).toEqual(expect.objectContaining({
        title: 'Enqueue TAKT task',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'task', 'workflow', 'autoPr']),
          properties: expect.objectContaining({ issue: expect.any(Object) }),
        }),
      }));
      expect(tools.tools[1]).toEqual(expect.objectContaining({
        title: 'List TAKT tasks',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: ['cwd'],
          properties: expect.objectContaining({ cwd: expect.any(Object) }),
        }),
      }));
    } finally {
      await client.close();
      await server.close();
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
      const listed = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listed.isError).toBeUndefined();
      expect(JSON.parse(String(listed.content[0]?.text))).toEqual({
        summary: {
          total: 0,
          pending: 0,
          running: 0,
          completed: 0,
          failed: 0,
          exceeded: 0,
          pr_failed: 0,
        },
        tasks: [],
      });
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
      expect(JSON.parse(String(created.content[0]?.text))).toEqual(expect.objectContaining({
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
      expect(JSON.parse(String(result.content[0]?.text))).toEqual({
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
      expect(String(removed.content[0]?.text)).toContain('not found');
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
