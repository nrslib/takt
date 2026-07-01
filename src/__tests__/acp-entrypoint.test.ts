import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaktAcpAgentApp } from '../app/acp/index.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { initDebugLogger, resetDebugLogger } from '../shared/utils/debug.js';

const SOURCE_STDIO_ENTRYPOINT_RUNNER = 'src/__tests__/helpers/acp-source-stdio-entrypoint.ts';
const CHILD_TERMINATION_TIMEOUT_MS = 1_000;

function writeSmokeProject(projectDir: string): string {
  mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
  mkdirSync(join(projectDir, '.takt', 'agents'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n', 'utf-8');
  writeFileSync(join(projectDir, '.takt', 'agents', 'worker.md'), 'You are a worker.', 'utf-8');
  writeFileSync(join(projectDir, '.takt', 'workflows', 'default.yaml'), `
name: default
description: ACP stdio smoke workflow
max_steps: 1
initial_step: start

steps:
  - name: start
    persona: ../agents/worker.md
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Do the work"
`, 'utf-8');

  const scenarioPath = join(projectDir, 'mock-scenario.json');
  writeFileSync(
    scenarioPath,
    JSON.stringify([{ status: 'done', content: '[START:1]\n\nDone.' }]),
    'utf-8',
  );
  return scenarioPath;
}

function spawnSourceStdioEntrypoint(scenarioPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    'node_modules/.bin/vite-node',
    '--script',
    SOURCE_STDIO_ENTRYPOINT_RUNNER,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TAKT_MOCK_SCENARIO: scenarioPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  if (await waitForChildExit(child, CHILD_TERMINATION_TIMEOUT_MS)) {
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGKILL');
  await waitForChildExit(child, CHILD_TERMINATION_TIMEOUT_MS);
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onExit = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(true);
    };
    timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function childTransport(child: ChildProcessWithoutNullStreams) {
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  return ndJsonStream(
    output as unknown as globalThis.WritableStream<Uint8Array>,
    input as unknown as globalThis.ReadableStream<Uint8Array>,
  );
}

describe('ACP package entrypoint', () => {
  let debugLogDir: string | undefined;

  afterEach(() => {
    resetDebugLogger();
    if (debugLogDir) {
      rmSync(debugLogDir, { recursive: true, force: true });
      debugLogDir = undefined;
    }
  });

  it('should expose a dedicated takt-acp binary for stdio JSON-RPC', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin).toEqual(expect.objectContaining({
      'takt-acp': './dist/app/acp/index.js',
    }));
  });

  it('should depend on the official ACP TypeScript SDK', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual(expect.objectContaining({
      '@agentclientprotocol/sdk': expect.any(String),
    }));
  });

  it('should force kill the source stdio child when graceful termination hangs', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') {
        child.signalCode = 'SIGKILL';
        child.emit('exit', null, 'SIGKILL');
      }
      return true;
    });

    try {
      const termination = terminateChild(child);

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(CHILD_TERMINATION_TIMEOUT_MS);
      await termination;

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should serve initialize, session/new, session/prompt, and session/update over the SDK stream transport', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };
    debugLogDir = join(tmpdir(), `takt-acp-hook-${Date.now()}`);
    const debugLogPath = join(debugLogDir, 'debug.log');
    initDebugLogger({ enabled: true, logFile: debugLogPath }, '/repo');
    const updates: string[] = [];
    const runWorkflowExecution = vi.fn(async (request: {
      eventSink?: (event: unknown) => void | Promise<void>;
    }) => {
      await request.eventSink?.({
        type: 'run_started',
        runDirectory: '/repo/.takt/runs/run-1',
        reportDirectory: '/repo/.takt/runs/run-1/reports',
        ndjsonLogPath: '/repo/.takt/runs/run-1/logs/session.ndjson',
      });
      await request.eventSink?.({
        type: 'step_started',
        step: 'implement',
        iteration: 1,
        maxSteps: 3,
      });
      await request.eventSink?.({
        type: 'progress',
        message: 'workflow running',
      });
      return {
        success: true,
        reportDirectory: '/repo/.takt/runs/run-1/reports',
      };
    });
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'workflow_execution_requested',
          task: 'Implement ACP support',
          interactiveMetadata: {
            confirmed: true,
            task: 'Implement ACP support',
          },
        }),
      })),
      runWorkflowExecution,
      sendSessionUpdate: vi.fn().mockRejectedValue(new Error('hook failed')),
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await client({ name: 'takt-acp-test-client' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (
          params.update.sessionUpdate === 'agent_message_chunk'
          && params.update.content.type === 'text'
        ) {
          updates.push(params.update.content.text);
        }
      })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        const initializeResponse = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const sessionResponse = await agent.request(methods.agent.session.new, {
          cwd: '/repo',
          mcpServers: [],
        });
        const promptResponse = await agent.request(methods.agent.session.prompt, {
          sessionId: sessionResponse.sessionId,
          prompt: [{ type: 'text', text: '/play Implement ACP support' }],
        });
        return {
          initializeResponse,
          sessionResponse,
          promptResponse,
        };
      });

    expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.initializeResponse.agentInfo).toEqual({
      name: 'TAKT',
      version: packageJson.version,
    });
    expect(result.sessionResponse.sessionId).toEqual(expect.any(String));
    expect(result.promptResponse).toEqual({ stopReason: 'end_turn' });
    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'default',
    }));
    expect(updates).toContain('Workflow started. Report: /repo/.takt/runs/run-1/reports');
    expect(updates).toContain('Starting step "implement" (1/3)');
    expect(updates).toContain('workflow running');
    expect(updates).toContain('Workflow completed. Report: /repo/.takt/runs/run-1/reports');
    const debugLog = readFileSync(debugLogPath, 'utf-8');
    expect(debugLog).toContain('ACP session update hook failed');
    expect(debugLog).toContain('hook failed');
  });

  it('should create an SDK stream session when mcpServers is omitted', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const createConversationSession = vi.fn(() => ({
      handleUserMessage: vi.fn(),
    }));
    const app = createTaktAcpAgentApp({
      createConversationSession,
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const sessionResponse = await client({ name: 'takt-acp-optional-mcp-test-client' })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return agent.request(methods.agent.session.new, {
          cwd: '/repo',
        });
      });

    expect(sessionResponse.sessionId).toEqual(expect.any(String));
    expect(createConversationSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      outputMode: 'silent',
    }));
  });

  it('should reject invalid session/new defaultAction over the SDK stream transport', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
      })),
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    await expect(client({ name: 'takt-acp-invalid-default-action-test-client' })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return agent.request(methods.agent.session.new, {
          cwd: '/repo',
          defaultAction: 'invalid',
          mcpServers: [],
        } as never);
      })).rejects.toThrow(/defaultAction|invalid/i);
  });

  it('should pass session/new defaultAction from root params into enqueue handling', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const updates: string[] = [];
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support',
      workflowIdentifier: 'review',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support',
      },
    });
    const deps = {
      defaultAction: 'direct' as const,
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
    };
    const app = createTaktAcpAgentApp(deps);
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await client({ name: 'takt-acp-default-action-test-client' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (
          params.update.sessionUpdate === 'agent_message_chunk'
          && params.update.content.type === 'text'
        ) {
          updates.push(params.update.content.text);
        }
      })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const sessionNewRequest = {
          cwd: '/repo',
          defaultAction: 'enqueue',
          mcpServers: [],
        };
        const sessionResponse = await agent.request(methods.agent.session.new, sessionNewRequest);
        return agent.request(methods.agent.session.prompt, {
          sessionId: sessionResponse.sessionId,
          prompt: [{ type: 'text', text: '/go include progress updates' }],
        });
      });

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'include progress updates',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'review',
      worktree: true,
      autoPr: false,
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
    expect(updates).toContainEqual(
      expect.stringMatching(/pending[\s\S]*worktree: true[\s\S]*workflow: review[\s\S]*takt run/i),
    );
  });

  it('should pass session/new defaultAction direct from root params into workflow execution', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const updates: string[] = [];
    const runWorkflowExecution = vi.fn(async (request: {
      eventSink?: (event: unknown) => void | Promise<void>;
    }) => {
      await request.eventSink?.({
        type: 'progress',
        message: 'workflow running from root direct defaultAction',
      });
      return {
        success: true,
        reportDirectory: '/repo/.takt/runs/run-1/reports',
      };
    });
    const saveTaskFile = vi.fn();
    const createTaskInstruction = vi.fn().mockResolvedValue({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support',
      },
    });
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await client({ name: 'takt-acp-root-direct-default-action-test-client' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (
          params.update.sessionUpdate === 'agent_message_chunk'
          && params.update.content.type === 'text'
        ) {
          updates.push(params.update.content.text);
        }
      })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const sessionResponse = await agent.request(methods.agent.session.new, {
          cwd: '/repo',
          defaultAction: 'direct',
          mcpServers: [],
        });
        return agent.request(methods.agent.session.prompt, {
          sessionId: sessionResponse.sessionId,
          prompt: [{ type: 'text', text: '/go include progress updates' }],
        });
      });

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(createTaskInstruction).toHaveBeenCalledWith(expect.objectContaining({
      userNote: 'include progress updates',
      abortSignal: expect.any(AbortSignal),
    }));
    expect(runWorkflowExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Implement ACP support',
      cwd: '/repo',
      projectCwd: '/repo',
      workflowIdentifier: 'default',
      outputMode: 'silent',
    }));
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(updates).toContain('Starting direct workflow execution: default');
    expect(updates).toContain('workflow running from root direct defaultAction');
  });

  it('should pass session/new taskContext from root params into enqueue handling', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const runWorkflowExecution = vi.fn();
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: '20260701-implement-acp-support',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createTaskInstruction = vi.fn().mockResolvedValue({
      kind: 'workflow_execution_requested',
      task: 'Implement ACP support',
      workflowIdentifier: 'review',
      interactiveMetadata: {
        confirmed: true,
        task: 'Implement ACP support',
      },
    });
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn().mockResolvedValue({
          kind: 'assistant_response',
          content: 'conversation path should not be used',
        }),
        createTaskInstruction,
      })),
      runWorkflowExecution,
      saveTaskFile,
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    const result = await client({ name: 'takt-acp-task-context-test-client' })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const sessionNewRequest = {
          cwd: '/repo',
          mcpServers: [],
          taskContext: {
            branch: 'takt/789/entrypoint-context',
            baseBranch: 'main',
            prNumber: 789,
          },
        };
        const sessionResponse = await agent.request(methods.agent.session.new, sessionNewRequest);
        return agent.request(methods.agent.session.prompt, {
          sessionId: sessionResponse.sessionId,
          prompt: [{ type: 'text', text: 'pending task にして' }],
        });
      });

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement ACP support', {
      workflow: 'review',
      worktree: true,
      autoPr: false,
      branch: 'takt/789/entrypoint-context',
      baseBranch: 'main',
      prNumber: 789,
    });
    expect(runWorkflowExecution).not.toHaveBeenCalled();
  });

  it('should reject invalid session/new taskContext branch over the SDK stream transport', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const saveTaskFile = vi.fn();
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction: vi.fn(),
      })),
      saveTaskFile,
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    await expect(client({ name: 'takt-acp-invalid-task-context-test-client' })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return agent.request(methods.agent.session.new, {
          cwd: '/repo',
          mcpServers: [],
          taskContext: {
            branch: 'HEAD:refs/heads/takt/injected',
          },
        });
      })).rejects.toThrow('Invalid params');
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('should reject Git option session/new taskContext branch over the SDK stream transport', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const saveTaskFile = vi.fn();
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction: vi.fn(),
      })),
      saveTaskFile,
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    await expect(client({ name: 'takt-acp-git-option-task-context-test-client' })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return agent.request(methods.agent.session.new, {
          cwd: '/repo',
          mcpServers: [],
          taskContext: {
            branch: '--upload-pack=echo',
          },
        });
      })).rejects.toThrow('Invalid params');
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('should reject invalid session/new taskContext baseBranch over the SDK stream transport', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const saveTaskFile = vi.fn();
    const app = createTaktAcpAgentApp({
      createConversationSession: vi.fn(() => ({
        handleUserMessage: vi.fn(),
        createTaskInstruction: vi.fn(),
      })),
      saveTaskFile,
    });
    app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

    await expect(client({ name: 'takt-acp-invalid-base-branch-test-client' })
      .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return agent.request(methods.agent.session.new, {
          cwd: '/repo',
          mcpServers: [],
          taskContext: {
            baseBranch: 'origin/main',
          },
        });
      })).rejects.toThrow('Invalid params');
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('should execute a real workflow API run through the SDK stream transport', async () => {
    const projectDir = join(tmpdir(), `takt-acp-entrypoint-${Date.now()}`);
    try {
      mkdirSync(join(projectDir, '.takt', 'workflows'), { recursive: true });
      mkdirSync(join(projectDir, '.takt', 'agents'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n', 'utf-8');
      writeFileSync(join(projectDir, '.takt', 'agents', 'worker.md'), 'You are a worker.', 'utf-8');
      writeFileSync(join(projectDir, '.takt', 'workflows', 'acp-smoke.yaml'), `
name: acp-smoke
description: ACP smoke workflow
max_steps: 1
initial_step: start

steps:
  - name: start
    persona: ../agents/worker.md
    rules:
      - condition: Done
        next: COMPLETE
    instruction: "Do the work"
`, 'utf-8');
      setMockScenario([
        { status: 'done', content: '[START:1]\n\nDone.' },
      ]);

      const clientToAgent = new TransformStream<Uint8Array>();
      const agentToClient = new TransformStream<Uint8Array>();
      const updates: string[] = [];
      const app = createTaktAcpAgentApp({
        createConversationSession: vi.fn(() => ({
          handleUserMessage: vi.fn().mockResolvedValue({
            kind: 'workflow_execution_requested',
            task: 'Run ACP smoke',
            workflowIdentifier: 'acp-smoke',
          }),
        })),
      });
      app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable));

      const result = await client({ name: 'takt-acp-real-workflow-test-client' })
        .onNotification(methods.client.session.update, ({ params }) => {
          if (
            params.update.sessionUpdate === 'agent_message_chunk'
            && params.update.content.type === 'text'
          ) {
            updates.push(params.update.content.text);
          }
        })
        .connectWith(ndJsonStream(clientToAgent.writable, agentToClient.readable), async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const sessionResponse = await agent.request(methods.agent.session.new, {
            cwd: projectDir,
            mcpServers: [],
          });
          return agent.request(methods.agent.session.prompt, {
            sessionId: sessionResponse.sessionId,
            prompt: [{ type: 'text', text: '/play Run ACP smoke' }],
          });
        });

      expect(result).toEqual({ stopReason: 'end_turn' });
      expect(updates.some((text) => text.startsWith('Workflow started. Report:'))).toBe(true);
      expect(updates).toContain('Starting step "start" (1/1)');
      expect(updates).toContain('[START:1]\n\nDone.');
      expect(updates.some((text) => text.startsWith('Workflow completed. Report:'))).toBe(true);
    } finally {
      resetScenario();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('should serve initialize, session/new, and session/prompt from the source stdio entrypoint', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'takt-acp-stdio-'));
    const scenarioPath = writeSmokeProject(projectDir);
    const child = spawnSourceStdioEntrypoint(scenarioPath);
    const stderrChunks: Buffer[] = [];
    const updates: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client({ name: 'takt-acp-stdio-test-client' })
          .onNotification(methods.client.session.update, ({ params }) => {
            if (
              params.update.sessionUpdate === 'agent_message_chunk'
              && params.update.content.type === 'text'
            ) {
              updates.push(params.update.content.text);
            }
          })
          .connectWith(childTransport(child), async (agent) => {
            const initializeResponse = await agent.request(methods.agent.initialize, {
              protocolVersion: PROTOCOL_VERSION,
              clientCapabilities: {},
            });
            const sessionResponse = await agent.request(methods.agent.session.new, {
              cwd: projectDir,
              mcpServers: [],
            });
            const promptResponse = await agent.request(methods.agent.session.prompt, {
              sessionId: sessionResponse.sessionId,
              prompt: [{ type: 'text', text: '/play Run ACP stdio smoke' }],
            });
            return { initializeResponse, sessionResponse, promptResponse };
          }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');
            reject(new Error(`ACP stdio smoke test timed out${stderr ? `\n${stderr}` : ''}`));
          }, 10_000);
        }),
      ]);

      expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(result.sessionResponse.sessionId).toEqual(expect.any(String));
      expect(result.promptResponse).toEqual({ stopReason: 'end_turn' });
      expect(updates.some((text) => text.startsWith('Workflow started. Report:'))).toBe(true);
      expect(updates).toContain('Starting step "start" (1/1)');
      expect(updates).toContain('[START:1]\n\nDone.');
      expect(updates.some((text) => text.startsWith('Workflow completed. Report:'))).toBe(true);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      await terminateChild(child);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
