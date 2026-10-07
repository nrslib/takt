import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenCodeProvider } from '../infra/providers/opencode.js';
import { OpenCodeClient } from '../infra/opencode/client.js';
import { resetSharedServerPool } from '../infra/opencode/server-pool.js';
import { buildOpenCodePromptTools } from '../infra/opencode/types.js';
import { runAgent } from '../agents/runner.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller.js';
import { runStatusJudgmentPhase } from '../core/workflow/status-judgment-phase.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import { createSkillPermissionHandler } from '../features/tasks/execute/skillPermissionHandler.js';
import { confirmWithCancel } from '../shared/prompt/confirm.js';
import type { WorkflowStep } from '../core/models/types.js';
import type { ProviderCallOptions } from '../infra/providers/types.js';
import type { OpenCodeTransport } from '../infra/opencode/transport.js';
import type { OpenCodeRuntime } from '../infra/opencode/runtime.js';
import { MockEventStream, deferred, unavailableToolErrorEvent } from './helpers/opencode-client-test-helpers.js';

const { startServer, promptAsync, createSession, resolveModel, permissionReply, replies, eventPlans } = vi.hoisted(() => ({
  startServer: vi.fn(), promptAsync: vi.fn(), createSession: vi.fn(), resolveModel: vi.fn(), replies: [] as string[],
  permissionReply: vi.fn(async () => undefined),
  eventPlans: [] as unknown[][],
}));

vi.mock('node:net', () => ({ createServer: () => ({
  unref: vi.fn(), on: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready(),
  address: () => ({ port: 62000 }), close: (done: (error?: Error) => void) => done(),
}) }));
vi.mock('../infra/opencode/server-process.js', () => ({ startOpenCodeServer: startServer }));
vi.mock('../shared/prompt/confirm.js', () => ({ confirmWithCancel: vi.fn() }));
vi.mock('../infra/opencode/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/opencode/runtime.js')>();
  return { ...actual, resolveOpenCodeRuntime: async (): Promise<OpenCodeRuntime> => ({
    ...actual.openCodeRuntimeSelection(), version: actual.openCodeRuntimeSelection().generation === 'v1' ? '1.18.2' : 'opencode v2.0.18',
  }) };
});

const step: WorkflowStep = {
  name: 'implement', personaDisplayName: 'coder', instruction: 'task', passPreviousResponse: false,
  rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' }), normalizeRule({ condition: 'needs_fix', next: 'implement' })],
};

function skillOptions(enabled: boolean) {
  return { opencode: { variant: 'high', skills: { enabled } } };
}

function callOptions(enabled?: boolean): ProviderCallOptions {
  return { cwd: '/work', model: 'probe/probe', opencodeApiKey: 'fixture-key',
    ...(enabled === undefined ? {} : { providerOptions: skillOptions(enabled) }) };
}

function optionsBuilder(options: Partial<WorkflowEngineOptions> = {}): OptionsBuilder {
  return new OptionsBuilder({ projectCwd: '/work', provider: 'opencode', model: 'probe/probe', providerOptions: skillOptions(true), ...options },
    () => '/work', () => '/work', () => undefined, () => '/work/reports', () => 'en', () => [step],
    () => 'workflow', () => undefined);
}

function sentTools(index: number): Record<string, boolean> {
  return promptAsync.mock.calls[index]![0].tools;
}

function agentPermissions(agent: string): Array<{ action: string; resource: string; effect: string }> {
  return startServer.mock.calls[0]![0].config.agents[agent].permissions;
}

beforeEach(() => {
  resetSharedServerPool();
  vi.clearAllMocks();
  vi.stubEnv('TAKT_OPENCODE_VERSION', 'v2');
  replies.splice(0);
  eventPlans.splice(0);
  let sessionCount = 0;
  createSession.mockImplementation(async () => ({ data: { id: `skill-session-${++sessionCount}` } }));
  promptAsync.mockResolvedValue(undefined);
  resolveModel.mockResolvedValue({ providerID: 'probe', modelID: 'probe' });
  startServer.mockImplementation(async () => {
    let summaryCount = 0;
    const client: OpenCodeTransport = {
      nativeStructuredOutput: false,
      resolveModel,
      session: {
        create: createSession,
        get: async ({ sessionID }) => ({ data: { id: sessionID } }),
        messages: async () => ({ data: summaryCount === 0 ? [] : [{
          info: { id: `summary-${summaryCount}`, role: 'assistant', summary: true, time: { created: 1, completed: 1 } },
          parts: [],
        }] }),
        promptAsync,
        abort: async () => ({ data: true }),
        summarize: async () => { summaryCount += 1; },
      },
      event: { subscribe: async ({ sessionID }) => ({ stream: (async function* () {
        const events = eventPlans.shift();
        if (events) {
          yield* new MockEventStream(events, sessionID);
          return;
        }
        const text = replies.shift() ?? 'done';
        yield { type: 'message.part.updated', properties: { part: { id: 'part', sessionID, type: 'text', text }, delta: text } };
        yield { type: 'session.idle', properties: { sessionID } };
      })() }) },
      permission: { reply: permissionReply },
      question: { reply: async () => undefined, reject: async () => undefined },
    };
    return { client, close: vi.fn(async () => {}), onError: () => () => {} };
  });
});

afterEach(() => {
  resetSharedServerPool();
  vi.unstubAllEnvs();
});

describe('OpenCode Skill execution contract', () => {
  it.each([undefined, false])('disables Skill for an omitted or false setting: %s', async (enabled) => {
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', { ...callOptions(enabled), allowedTools: ['Read'] });
    expect(response.status).toBe('done');
    expect(sentTools(0).read).toBe(true);
    expect(sentTools(0).skill).toBe(false);
    for (const agent of ['takt', 'takt-review', 'takt-report']) {
      expect(agentPermissions(agent)).toContainEqual({ action: 'skill', resource: '*', effect: 'deny' });
    }
  });

  it('enables OpenCode Skill from OpenCode options in Phase 1', async () => {
    const options = optionsBuilder().buildBaseOptions(step);
    const response = await runAgent(undefined, 'task', options);
    expect(response.status).toBe('done');
    expect(sentTools(0).skill).toBe(true);
    for (const agent of ['takt', 'takt-review', 'takt-report']) {
      expect(agentPermissions(agent).filter((rule) => rule.action === 'skill' || rule.action === '*')).toEqual([]);
    }
  });

  it('does not enable OpenCode Skill from a Claude-only Skill setting', async () => {
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(), providerOptions: { claude: { skills: { enabled: true } } }, allowedTools: ['Read'],
    });
    expect(response.status).toBe('done');
    expect(sentTools(0).read).toBe(true);
    expect(sentTools(0).skill).toBe(false);
  });

  it.each([
    { permissionMode: 'readonly' as const, allowedTools: ['Read'] },
    { permissionMode: 'readonly' as const, allowedTools: [] },
  ])('keeps explicit Phase 1 Skill enabled with restrictions %j', async (restrictions) => {
    const options = optionsBuilder().buildBaseOptions(step);
    const response = await runAgent(undefined, 'task', { ...options, permissionResolution: undefined, ...restrictions });
    expect(response.status).toBe('done');
    expect(sentTools(0).skill).toBe(true);
  });

  it('turns Skill off for a report on the same session and restores it on Phase 1 resume', async () => {
    const builder = optionsBuilder();
    const first = await runAgent(undefined, 'task', builder.buildBaseOptions(step));
    expect(first.status).toBe('done');
    expect(sentTools(0).skill).toBe(true);
    const reportOptions = builder.buildResumeOptions(step, first.sessionId!, {});
    expect(reportOptions.providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    const report = await runAgent(undefined, 'report', reportOptions);
    expect(report.status).toBe('done');
    expect(sentTools(1).skill).toBe(false);
    expect(reportOptions.providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    const resumed = await runAgent(undefined, 'continue', { ...builder.buildBaseOptions(step), sessionId: report.sessionId });
    expect(resumed.status).toBe('done');
    expect(sentTools(2).skill).toBe(true);
    expect(promptAsync.mock.calls.map(([payload]) => payload.sessionID)).toEqual([first.sessionId, first.sessionId, first.sessionId]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it('keeps Skill off for a fresh-session report retry while retaining the step setting', async () => {
    const options = optionsBuilder().buildNewSessionReportOptions(step, { allowedTools: ['Read'] });
    expect(options.providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    const response = await runAgent(undefined, 'report retry', options);
    expect(response.status).toBe('done');
    expect(sentTools(0).read).toBe(true);
    expect(sentTools(0).skill).toBe(false);
    expect(options.providerOptions).toMatchObject({ opencode: { skills: { enabled: true } } });
    for (const agent of ['takt', 'takt-review', 'takt-report']) {
      expect(agentPermissions(agent).filter((rule) => rule.action === 'skill' || rule.action === '*')).toEqual([]);
    }
  });

  it('forces Skill off when strict-readonly is specified on a regular provider call', async () => {
    const response = await new OpenCodeProvider().setup({ name: 'internal' }).call('task', {
      ...callOptions(true), internalAgentIsolation: 'strict-readonly', permissionMode: 'readonly', allowedTools: ['Read'],
    });
    expect(response.status).toBe('done');
    expect(sentTools(0).skill).toBe(false);
  });

  it('forces Skill off through the actual status judgment entry point', async () => {
    replies.push('{"step":1,"reason":"approved"}');
    const result = await runStatusJudgmentPhase(step, {
      cwd: '/work', reportDir: '/work/reports', workflowName: 'workflow', lastResponse: 'done', iteration: 1,
      resolveStepProviderModel: () => ({ provider: 'opencode', model: 'probe/probe', providerOptions: skillOptions(true) }),
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    expect(result.label).toBe('approved');
    expect(promptAsync).toHaveBeenCalled();
    for (const [payload] of promptAsync.mock.calls) expect(payload.tools.skill).toBe(false);
  });

  it.each(['allow', 'deny', undefined] as const)('uses an explicit native Skill permission decision: %s', async (behavior) => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'message.part.updated', properties: { part: { id: 'part', type: 'text', text: 'done' }, delta: 'done' } },
      { type: 'session.idle', properties: {} },
    ]);
    const handler = vi.fn(async () => behavior === 'allow'
      ? { behavior: 'allow' as const, updatedInput: {} }
      : { behavior: 'deny' as const, message: 'denied' });
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(true), allowedTools: ['Read'], permissionMode: 'full',
      ...(behavior === undefined ? {} : { onPermissionRequest: handler }),
    });
    expect(response.status).toBe('done');
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({ reply: behavior === 'allow' ? 'once' : 'reject' }), expect.anything());
    if (behavior === undefined) expect(handler).not.toHaveBeenCalled();
    else expect(handler).toHaveBeenCalledWith({ toolName: 'skill', input: { patterns: ['probe-repo'] } });
  });

  it.each([true, false])('propagates the workflow Skill handler to native reply: %s', async (allowed) => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'session.idle', properties: {} },
    ]);
    vi.mocked(confirmWithCancel).mockResolvedValue({ kind: 'value', value: allowed });
    const handler = createSkillPermissionHandler({ current: null }, 'en');
    const response = await runAgent(undefined, 'task', optionsBuilder({ onSkillPermissionRequest: handler }).buildBaseOptions(step));
    expect(response.status).toBe('done');
    expect(confirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('["probe-repo"]'), false, expect.any(AbortSignal));
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({ reply: allowed ? 'once' : 'reject' }), expect.anything());
  });

  it.each(['allow', 'deny'] as const)('keeps explicit callback priority over workflow Skill input: %s', async (behavior) => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'session.idle', properties: {} },
    ]);
    const skillHandler = vi.fn(async () => true);
    await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(true), onSkillPermissionRequest: skillHandler,
      onPermissionRequest: async () => behavior === 'allow' ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: 'denied' },
    });
    expect(skillHandler).not.toHaveBeenCalled();
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({ reply: behavior === 'allow' ? 'once' : 'reject' }), expect.anything());
  });

  it.each([
    { providerOptions: skillOptions(false) },
    { providerOptions: undefined },
    { executionPhase: 2 as const },
    { executionPhase: 3 as const },
    { internalAgentIsolation: 'strict-readonly' as const },
  ])('does not consume workflow Skill input with restrictions %j', async (restrictions) => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'session.idle', properties: {} },
    ]);
    const handler = vi.fn(async () => true);
    await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(true), ...restrictions, onSkillPermissionRequest: handler,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(sentTools(0).skill).toBe(false);
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({ reply: 'reject' }), expect.anything());
  });

  it('aborts Skill input with the call and never sends permission approval', async () => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'session.idle', properties: {} },
    ]);
    const controller = new AbortController();
    let inputSignal: AbortSignal | undefined;
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(true), abortSignal: controller.signal,
      onSkillPermissionRequest: async (_request, signal) => {
        inputSignal = signal;
        controller.abort();
        return true;
      },
    });
    expect(inputSignal?.aborted).toBe(true);
    expect(response.status).toBe('error');
    expect(permissionReply).not.toHaveBeenCalled();
  });

  it.each([true, false])('waits for Skill input past the interaction deadline and replies: %s', async (allowed) => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'session.idle', properties: {} },
    ]);
    const entered = deferred();
    const answer = deferred<{ kind: 'value'; value: boolean }>();
    let inputSignal: AbortSignal | undefined;
    vi.mocked(confirmWithCancel).mockImplementation(async (_message, _default, signal) => {
      inputSignal = signal;
      entered.resolve();
      return answer.promise;
    });
    vi.useFakeTimers();
    try {
      const responsePromise = new OpenCodeClient().callCustom('coder', 'task', 'system', {
        cwd: '/work', model: 'probe/probe', skillsEnabled: true, interactionTimeoutMs: 20,
        onSkillPermissionRequest: createSkillPermissionHandler({ current: null }, 'en'),
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(21);
      expect(inputSignal?.aborted).toBe(false);
      expect(permissionReply).not.toHaveBeenCalled();
      answer.resolve({ kind: 'value', value: allowed });
      const response = await responsePromise;
      expect(response.status).toBe('done');
      expect(permissionReply).toHaveBeenCalledWith(
        expect.objectContaining({ reply: allowed ? 'once' : 'reject' }),
        expect.anything(),
      );
    } finally {
      answer.resolve({ kind: 'value', value: false });
      vi.useRealTimers();
    }
  });

  it.each(['v1', 'v2'] as const)('does not use Skill input for a general permission request on %s', async (generation) => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', generation);
    eventPlans.push([
      { type: generation === 'v2' ? 'permission.asked' : 'permission.updated', properties: { id: 'permission', permission: 'write', type: 'write', patterns: ['target'] } },
      { type: 'session.idle', properties: {} },
    ]);
    const handler = vi.fn(async () => true);
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(true), onSkillPermissionRequest: handler,
    });
    expect(response.status).toBe('done');
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps Skill disabled through all status judgment fallback stages', async () => {
    replies.push('invalid', '{"content":"invalid"}', '{"matched_index":1,"reason":"approved"}');
    const result = await runStatusJudgmentPhase(step, {
      cwd: '/work', reportDir: '/work/reports', workflowName: 'workflow', lastResponse: 'done', iteration: 1,
      resolveStepProviderModel: () => ({ provider: 'opencode', model: 'probe/probe', providerOptions: skillOptions(true) }),
      structuredCaller: new ProviderNeutralStructuredCaller(),
    });
    expect(result.label).toBe('approved');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    for (const [payload] of promptAsync.mock.calls) expect(payload.tools.skill).toBe(false);
  });

  it('does not delegate Skill permission when Skill is disabled', async () => {
    eventPlans.push([
      { type: 'permission.asked', properties: { id: 'permission', permission: 'skill', patterns: ['probe-repo'] } },
      { type: 'session.idle', properties: {} },
    ]);
    const handler = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
    await new OpenCodeProvider().setup({ name: 'coder' }).call('task', { ...callOptions(false), onPermissionRequest: handler });
    expect(handler).not.toHaveBeenCalled();
    expect(permissionReply).toHaveBeenCalledWith(expect.objectContaining({ reply: 'reject' }), expect.anything());
  });

  it.each([undefined, false, true])('ignores the Skill setting on v1: %s', async (enabled) => {
    vi.stubEnv('TAKT_OPENCODE_VERSION', 'v1');
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', { ...callOptions(enabled), allowedTools: ['Read'] });
    expect(response.status).toBe('done');
    expect(sentTools(0)).toEqual(buildOpenCodePromptTools(undefined, undefined, ['Read']));
    const config = startServer.mock.calls[0]![0].config;
    expect(config.agent.takt.tools).toEqual({ task: false });
    expect(config.agent['takt-review'].tools).toEqual({ task: false });
    expect(config.permission).toEqual({ external_directory: 'deny' });
  });

  it('reuses the same server for equal Skill settings', async () => {
    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    await agent.call('first', callOptions(true));
    await agent.call('second', callOptions(true));
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(sentTools(0).skill).toBe(true);
    expect(sentTools(1).skill).toBe(true);
  });

  it('uses separate servers when only the Skill setting differs', async () => {
    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    const responses = await Promise.all([agent.call('on', callOptions(true)), agent.call('off', callOptions(false))]);
    expect(responses.map((response) => response.status)).toEqual(['done', 'done']);
    expect(startServer).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls.map(([payload]) => payload.tools.skill).sort()).toEqual([false, true]);
  });

  it.each([false, true])('preserves Skill settings while selecting the runtime default model: %s', async (enabled) => {
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(enabled), model: undefined, allowDefaultModel: true,
    });
    expect(response.status).toBe('done');
    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(sentTools(0).skill).toBe(enabled);
    for (const [options] of startServer.mock.calls) {
      for (const agent of ['takt', 'takt-review', 'takt-report']) {
        const rules = options.config.agents[agent].permissions as Array<{ action: string; resource: string; effect: string }>;
        if (enabled) expect(rules.filter((rule) => rule.action === 'skill' || rule.action === '*')).toEqual([]);
        else expect(rules).toContainEqual({ action: 'skill', resource: '*', effect: 'deny' });
      }
    }
  });

  it('restores the Skill setting on resume after the server pool restarts', async () => {
    const agent = new OpenCodeProvider().setup({ name: 'coder' });
    const first = await agent.call('first', callOptions(true));
    resetSharedServerPool();
    const second = await agent.call('resume', { ...callOptions(true), sessionId: first.sessionId });
    expect(second.status).toBe('done');
    expect(promptAsync.mock.calls.map(([payload]) => payload.sessionID)).toEqual([first.sessionId, first.sessionId]);
    expect(sentTools(1).skill).toBe(true);
    expect(startServer).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('uses the same Skill server during compaction and subsequent resume', async () => {
    const provider = new OpenCodeProvider();
    const agent = provider.setup({ name: 'coder' });
    const options = { ...callOptions(true), opencodeApiKey: undefined };
    const first = await agent.call('task', options);
    const compactOptions = { cwd: '/work', model: 'probe/probe', sessionId: first.sessionId!, providerOptions: skillOptions(true) };
    await provider.compactSession(compactOptions);
    await agent.call('resume', { ...options, sessionId: first.sessionId });
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(sentTools(1).skill).toBe(true);
  });

  it.each([false, true])('preserves Skill settings through a transient retry: %s', async (enabled) => {
    promptAsync.mockRejectedValueOnce(new Error('fetch failed'));
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', callOptions(enabled));
    expect(response.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
    for (const [payload] of promptAsync.mock.calls) expect(payload.tools.skill).toBe(enabled);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves Skill settings through fresh-session recovery: %s', async (enabled) => {
    eventPlans.push([
      unavailableToolErrorEvent('tool-1', 'call-1', 'StructuredOutput'),
      unavailableToolErrorEvent('tool-2', 'call-2', 'StructuredOutput'),
    ]);
    const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', {
      ...callOptions(enabled), sessionId: 'old-session',
    });
    expect(response.status).toBe('done');
    expect(response.sessionId).not.toBe('old-session');
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[0]![0].sessionID).toBe('old-session');
    expect(promptAsync.mock.calls[1]![0].sessionID).toBe(response.sessionId);
    for (const [payload] of promptAsync.mock.calls) expect(payload.tools.skill).toBe(enabled);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('does not change repository or user configuration and Skill files: %s', async (enabled) => {
    const root = mkdtempSync(join(tmpdir(), 'takt-opencode-skill-files-'));
    const cwd = join(root, 'repository');
    const home = join(root, 'home');
    vi.stubEnv('HOME', home);
    const fixtures = new Map<string, string>([
      [join(cwd, 'opencode.json'), '{"permissions":[{"action":"skill","resource":"*","effect":"ask"}]}\n'],
      [join(home, '.config/opencode/opencode.json'), '{"permissions":[{"action":"skill","resource":"*","effect":"deny"}]}\n'],
      ...[cwd, home].flatMap((base) => ['.opencode', '.claude', '.agents'].map((folder): [string, string] => [
        join(base, folder, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\nOriginal Skill content.\n',
      ])),
    ]);
    try {
      for (const [path, content] of fixtures) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      const response = await new OpenCodeProvider().setup({ name: 'coder' }).call('task', { ...callOptions(enabled), cwd });
      expect(response.status).toBe('done');
      for (const [path, content] of fixtures) expect(readFileSync(path, 'utf8')).toBe(content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
