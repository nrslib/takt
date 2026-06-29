import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream, WritableStream } from 'node:stream/web';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createTaktAcpAgentApp } from '../app/acp/index.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

describe('ACP package entrypoint', () => {
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

  it('should serve initialize, session/new, session/prompt, and session/update over the SDK stream transport', async () => {
    const clientToAgent = new TransformStream<Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array>();
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };
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

  it('should serve initialize, session/new, and session/prompt from the built stdio entrypoint', async () => {
    const projectDir = join(tmpdir(), `takt-acp-stdio-${Date.now()}`);
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n', 'utf-8');

    const child = spawn(process.execPath, ['dist/app/acp/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    try {
      const updates: string[] = [];
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
          .connectWith(ndJsonStream(
            Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
          ), async (agent) => {
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
              prompt: [{ type: 'text', text: 'Hello from spawned ACP test' }],
            });
            return { initializeResponse, sessionResponse, promptResponse };
          }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`ACP stdio smoke test timed out. stderr: ${Buffer.concat(stderrChunks).toString('utf-8')}`));
          }, 10_000);
        }),
      ]);

      expect(result.initializeResponse.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(result.sessionResponse.sessionId).toEqual(expect.any(String));
      expect(result.promptResponse).toEqual({ stopReason: 'end_turn' });
      expect(updates.some((text) => text.includes('Mock response for persona "interactive"'))).toBe(true);
    } finally {
      await terminateChild(child);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
