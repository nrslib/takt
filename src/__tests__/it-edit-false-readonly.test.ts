import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import type { ClaudeCallOptions } from '../infra/claude/types.js';
import type { OpenCodeCallOptions } from '../infra/opencode/types.js';
import { buildSdkOptions } from '../infra/claude/options-builder.js';
import { buildOpenCodePromptTools } from '../infra/opencode/types.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import { WorkflowEngine } from '../core/workflow/engine/WorkflowEngine.js';
import { createPartStep } from '../core/workflow/engine/team-leader-common.js';
import { runAgent } from '../agents/runner.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller.js';
import type { AgentResponse, NormalAgentWorkflowStep, WorkflowConfig } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { cleanupWorkflowEngine } from './engine-test-helpers.js';

vi.mock('../infra/managed-providers/loader.js', () => import('./helpers/managed-sdk.js'));
vi.mock('../infra/codex/skill-config.js', () => ({ buildCodexSkillConfig: () => ({}) }));

const { threads, turns } = vi.hoisted(() => ({
  threads: [] as ThreadOptions[],
  turns: [] as Array<{ threadOptions: ThreadOptions; schemaProperties: Record<string, unknown>; resumed: boolean }>,
}));
const { claudeCall, openCodeCall, spawnProcess } = vi.hoisted(() => ({
  claudeCall: vi.fn<(_name: string, _prompt: string, options: ClaudeCallOptions) => Promise<AgentResponse>>(),
  openCodeCall: vi.fn<(_name: string, _prompt: string, options: OpenCodeCallOptions) => Promise<AgentResponse>>(),
  spawnProcess: vi.fn(),
}));
vi.mock('../infra/claude/client.js', () => ({
  callClaude: claudeCall,
  callClaudeCustom: (name: string, prompt: string, _system: string, options: ClaudeCallOptions) => claudeCall(name, prompt, options),
}));
vi.mock('../infra/opencode/index.js', () => ({
  callOpenCode: openCodeCall,
  callOpenCodeCustom: (name: string, prompt: string, _system: string, options: OpenCodeCallOptions) => openCodeCall(name, prompt, options),
}));
vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/utils/index.js')>()),
  spawnManagedProcess: spawnProcess,
}));
vi.mock('@openai/codex-sdk', () => {
  function createThread(options: ThreadOptions, sessionId?: string) {
    threads.push(options);
    const id = sessionId ?? `thread-${threads.length}`;
    return {
      id,
      runStreamed: async (_input: unknown, turnOptions?: TurnOptions) => {
        const properties = (turnOptions?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        turns.push({ threadOptions: options, schemaProperties: properties, resumed: sessionId !== undefined });
        const text = Object.hasOwn(properties, 'done')
          ? JSON.stringify({ done: true, reasoning: 'finished', cancelPartIds: [], parts: [] })
          : Object.hasOwn(properties, 'parts')
            ? JSON.stringify({ parts: [{ id: 'p1', title: 'Review', instruction: 'Review' }] })
            : Object.hasOwn(properties, 'content')
              ? JSON.stringify({ content: '[STEP:1]' })
              : '[STEP:1]';
        return {
          events: (async function* () {
            yield { type: 'thread.started', thread_id: id };
            yield { type: 'item.completed', item: { id: 'message', type: 'agent_message', text } };
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
          })(),
        };
      },
    };
  }
  return {
    Codex: class {
      startThread(options: ThreadOptions) {
        return createThread(options);
      }
      resumeThread(sessionId: string, options: ThreadOptions) {
        return createThread(options, sessionId);
      }
    },
  };
});

describe('edit=false Phase 1 permission wiring', () => {
  let cwd: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-edit-false-'));
    threads.length = 0;
    turns.length = 0;
    vi.clearAllMocks();
    claudeCall.mockResolvedValue({ status: 'done', content: 'Reviewed', persona: 'reviewer', timestamp: new Date() });
    openCodeCall.mockResolvedValue({ status: 'done', content: 'Reviewed', persona: 'reviewer', timestamp: new Date() });
    spawnProcess.mockImplementation(() => {
      const stdout = new EventEmitter();
      return {
        child: { stdout, stderr: new EventEmitter() },
        wait: async () => {
          stdout.emit('data', Buffer.from('Reviewed'));
          return { code: 0, signal: null };
        },
      };
    });
  });

  afterEach(() => {
    if (engine) cleanupWorkflowEngine(engine);
    engine = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  function builder(engineOptions: Partial<WorkflowEngineOptions> = {}): OptionsBuilder {
    return new OptionsBuilder(
      { projectCwd: cwd, provider: 'codex', ...engineOptions },
      () => cwd, () => cwd, () => undefined, () => '.takt/reports', () => 'ja', () => 'test',
    );
  }

  const reviewStep: NormalAgentWorkflowStep = {
    name: 'review', personaDisplayName: 'reviewer', instruction: 'Review', passPreviousResponse: false, edit: false,
  };

  it.each(['takt', 'codex'] as const)('passes read-only to the SDK with permission_control=%s', async (permissionControl) => {
    const options = builder({ providerOptions: { codex: { permissionControl } } }).buildAgentOptions(reviewStep);
    expect((await runAgent(undefined, 'Review', options)).status).toBe('done');
    expect(threads).toEqual([expect.objectContaining({ sandboxMode: 'read-only' })]);
  });

  it.each([
    { edit: undefined, permissionControl: 'takt', sandbox: 'workspace-write' },
    { edit: true, permissionControl: 'takt', sandbox: 'workspace-write' },
    { edit: undefined, permissionControl: 'codex', sandbox: undefined },
    { edit: true, permissionControl: 'codex', sandbox: undefined },
  ] as const)('preserves edit=$edit with permission_control=$permissionControl', async ({ edit, permissionControl, sandbox }) => {
    const step = { ...reviewStep, edit };
    await runAgent(undefined, 'Work', builder({ providerOptions: { codex: { permissionControl } } }).buildAgentOptions(step));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.sandboxMode).toBe(sandbox);
  });

  it.each([
    { providerProfiles: { codex: { defaultPermissionMode: 'full' as const } } },
    { providerSource: 'runtime-v1' as const, providerPermissionMode: 'full' as const },
    { personaProviders: { reviewer: { provider: 'codex' as const, permissionMode: 'full' as const } } },
  ])('uses read-only despite explicit writable permissions for edit=false: %j', async (engineOptions) => {
    const step = { ...reviewStep, personaDisplayName: 'reviewer' };
    await runAgent(undefined, 'Review', builder(engineOptions).buildAgentOptions(step));
    expect(threads[0]?.sandboxMode).toBe('read-only');
  });

  it.each([
    { edit: false, partEdit: undefined },
    { edit: true, partEdit: false },
  ])('keeps team leader parts readonly (edit=$edit, partEdit=$partEdit)', async ({ edit, partEdit }) => {
    const partStep = createPartStep({
      name: 'review', personaDisplayName: 'reviewer', instruction: 'Review', passPreviousResponse: false, edit,
      teamLeader: { maxConcurrency: 1, timeoutMs: 1000, partEdit },
    }, { id: 'p1', title: 'Review', instruction: 'Review' });
    const options = builder({ providerOptions: { codex: { permissionControl: 'codex' } } }).buildAgentOptions(partStep);
    await runAgent(undefined, 'Review', options);
    expect(threads[0]?.sandboxMode).toBe('read-only');
  });

  it.each(['takt', 'codex'] as const)('keeps the loop monitor judge readonly with permission_control=%s', async (permissionControl) => {
    const workflow = normalizeWorkflowConfig({
      name: 'monitor', max_steps: 5, initial_step: 'review',
      steps: [
        { name: 'review', instruction: 'Review', rules: [{ condition: 'done', next: 'fix' }] },
        { name: 'fix', instruction: 'Fix', rules: [{ condition: 'done', next: 'review' }] },
      ],
      loop_monitors: [{ cycle: ['review', 'fix'], threshold: 1, judge: {
        instruction: 'Decide whether to stop', rules: [{ condition: 'stop', next: 'COMPLETE' }],
      } }],
    }, cwd);
    engine = new WorkflowEngine(workflow, cwd, 'Review', {
      projectCwd: cwd, provider: 'codex', providerOptions: { codex: { permissionControl } },
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason: string) => abortReasons.push(reason));
    expect((await engine.run()).status, abortReasons.join('\n')).toBe('completed');
    const judgeTurns = turns.filter((turn) => Object.hasOwn(turn.schemaProperties, 'content'));
    expect(judgeTurns).toHaveLength(1);
    expect(judgeTurns[0]?.resumed).toBe(false);
    expect(judgeTurns[0]?.threadOptions.sandboxMode).toBe('read-only');
  });

  it.each([
    { edit: false, permissionControl: 'takt', sandbox: 'read-only' },
    { edit: false, permissionControl: 'codex', sandbox: 'read-only' },
    { edit: true, permissionControl: 'takt', sandbox: 'workspace-write' },
    { edit: true, permissionControl: 'codex', sandbox: undefined },
    { edit: undefined, permissionControl: 'takt', sandbox: 'workspace-write' },
    { edit: undefined, permissionControl: 'codex', sandbox: undefined },
  ] as const)('passes leader edit=$edit through decomposition and feedback with permission_control=$permissionControl', async ({ edit, permissionControl, sandbox }) => {
    const workflow = normalizeWorkflowConfig({
      name: 'team', max_steps: 5, initial_step: 'review',
      steps: [{
        name: 'review', edit, instruction: 'Coordinate review',
        team_leader: { max_concurrency: 1, timeout_ms: 1000, part_edit: true },
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      }],
    }, cwd);
    engine = new WorkflowEngine(workflow, cwd, 'Review', {
      projectCwd: cwd, provider: 'codex', providerOptions: { codex: { permissionControl } },
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason: string) => abortReasons.push(reason));
    expect((await engine.run()).status, abortReasons.join('\n')).toBe('completed');
    const leaderTurns = turns.filter((turn) => Object.hasOwn(turn.schemaProperties, 'parts'));
    expect(leaderTurns).toHaveLength(2);
    expect(leaderTurns.map((turn) => turn.resumed)).toEqual([false, true]);
    expect(leaderTurns.map((turn) => turn.threadOptions.sandboxMode)).toEqual([sandbox, sandbox]);
    const partTurns = turns.filter((turn) => Object.keys(turn.schemaProperties).length === 0);
    expect(partTurns).toHaveLength(1);
    expect(partTurns[0]?.threadOptions.sandboxMode).toBe(permissionControl === 'takt' ? 'workspace-write' : undefined);
  });

  it.each(['claude', 'claude-sdk'] as const)('preserves %s permission mode and tool filter for edit=false', async (provider) => {
    const options = builder({
      provider,
      providerOptions: { claude: { allowedTools: ['Read', 'Grep', 'Write', 'Edit', 'Bash'] } },
    }).buildAgentOptions(reviewStep);
    expect(options.allowedTools).toEqual(['Read', 'Grep']);
    expect((await runAgent(undefined, 'Review', options)).status).toBe('done');
    const callOptions = claudeCall.mock.calls[0]![2];
    expect(callOptions.permissionMode).toBe('edit');
    expect(buildSdkOptions(callOptions)).toMatchObject({
      permissionMode: 'acceptEdits', allowedTools: ['Read', 'Grep'],
    });
  });

  it.each([undefined, ['Read', 'Grep', 'Write', 'Edit', 'Bash']])('preserves OpenCode shell access for edit=false (tools=%j)', async (allowedTools) => {
    const options = builder({
      provider: 'opencode', model: 'opencode/test',
      providerOptions: { opencode: { allowedTools } },
    }).buildAgentOptions(reviewStep);
    expect((await runAgent(undefined, 'Review', options)).status).toBe('done');
    const callOptions = openCodeCall.mock.calls[0]![2];
    expect(callOptions.permissionMode).toBe('edit');
    expect(callOptions.allowedTools).toEqual(allowedTools === undefined ? undefined : ['Read', 'Grep', 'Bash']);
    expect(buildOpenCodePromptTools(callOptions.permissionMode, undefined, callOptions.allowedTools).bash).toBe(true);
  });

  it.each([false, true])('preserves Copilot shell access and MCP startup for edit=false (MCP=%s)', async (withMcp) => {
    const options = builder({
      provider: 'copilot',
      ...(withMcp ? { mcpServers: { docs: { type: 'http' as const, url: 'https://example.com/mcp' } } } : {}),
    }).buildAgentOptions(reviewStep);
    expect((await runAgent(undefined, 'Review', options)).status).toBe('done');
    expect(spawnProcess).toHaveBeenCalledOnce();
    const args = spawnProcess.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--allow-all-tools', '--no-ask-user']));
    expect(args).not.toContain('--deny-tool=shell');
    expect(args.some((arg) => arg.startsWith('--additional-mcp-config=@'))).toBe(withMcp);
  });

  it('keeps parallel sub-steps and workflow_call child steps readonly', async () => {
    const child: WorkflowConfig = normalizeWorkflowConfig({
      name: 'child', subworkflow: { callable: true }, initial_step: 'child-review',
      steps: [{ name: 'child-review', edit: false, instruction: 'Review', rules: [{ condition: 'done', next: 'COMPLETE' }] }],
    }, cwd);
    const parent = normalizeWorkflowConfig({
      name: 'parent', max_steps: 5, initial_step: 'reviews',
      steps: [{ name: 'reviews', parallel: [
        { name: 'local-review', edit: false, instruction: 'Review', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
        { name: 'delegate-review', kind: 'workflow_call', call: 'child', rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }] },
      ], rules: [{ condition: 'all("COMPLETE")', next: 'COMPLETE' }] }],
    }, cwd);
    engine = new WorkflowEngine(parent, cwd, 'Review', {
      projectCwd: cwd, provider: 'codex', providerOptions: { codex: { permissionControl: 'codex' } },
      workflowCallResolver: () => child,
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason: string) => abortReasons.push(reason));
    const state = await engine.run();
    expect(state.status, abortReasons.join('\n')).toBe('completed');
    expect(threads).toHaveLength(2);
    expect(threads.every((thread) => thread.sandboxMode === 'read-only')).toBe(true);
  });
});
