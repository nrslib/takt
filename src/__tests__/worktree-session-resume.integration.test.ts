import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { buildSessionKey } from '../core/workflow/session-key.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import type { Provider, ProviderCompactSessionOptions } from '../infra/providers/types.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));

const { compactSession } = vi.hoisted(() => ({
  compactSession: vi.fn<(options: ProviderCompactSessionOptions) => Promise<void>>(),
}));

vi.mock('../core/workflow/engine/session-compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/engine/session-compaction.js')>();
  const provider: Provider = {
    supportsStructuredOutput: false,
    supportsNativeImageInput: false,
    getRuntimeInstructions: () => null,
    keepsAllowedToolWithoutEdit: () => false,
    setup: vi.fn(),
    compactSession,
  };
  return {
    ...actual,
    compactSessionBeforePhase1: ((step, options) => actual.compactSessionBeforePhase1(step, options, {
      getProvider: () => provider,
      warn: vi.fn(),
    })) satisfies typeof actual.compactSessionBeforePhase1,
  };
});

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { executeWorkflow } from '../features/tasks/execute/workflowExecution.js';
import {
  loadPersonaSessions,
  loadWorktreeSessions,
  updatePersonaSession,
} from '../infra/config/project/sessionStore.js';
import { makeRule, makeStep } from './test-helpers.js';

function agentStep(name: string, persona: string, next: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep({
    name,
    persona,
    personaDisplayName: persona,
    engineSynthesized: true,
    instruction: name,
    rules: [makeRule('when(true)', next)],
    ...overrides,
  });
}

function workflow(steps: WorkflowStep[]): WorkflowConfig {
  return { name: 'session-resume', initialStep: steps[0]!.name, maxSteps: 20, steps };
}

function reviewAndFix(): WorkflowConfig {
  return workflow([
    agentStep('review', 'reviewer', 'fix'),
    agentStep('fix', 'coder', 'review-again'),
    agentStep('review-again', 'reviewer', 'fix-again'),
    agentStep('fix-again', 'coder', 'COMPLETE'),
  ]);
}

describe('worktree session resume', () => {
  let root: string;
  let projectCwd: string;
  let cloneA: string;
  let cloneB: string;
  const engines: WorkflowEngine[] = [];

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    compactSession.mockReset();
    compactSession.mockResolvedValue(undefined);
    root = mkdtempSync(join(tmpdir(), 'takt-worktree-session-resume-'));
    projectCwd = join(root, 'project');
    cloneA = join(root, 'clone-a');
    cloneB = join(root, 'clone-b');
    for (const directory of [projectCwd, cloneA, cloneB]) {
      mkdirSync(join(directory, '.takt'), { recursive: true });
    }
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'provider: mock\nmodel: test-model\nanalytics:\n  enabled: false\n');
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: instruction });
      return {
        persona: String(persona),
        status: 'done',
        content: 'done',
        timestamp: new Date('2026-10-20T00:00:00.000Z'),
        sessionId: `session-${vi.mocked(runAgent).mock.calls.length}`,
      };
    });
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  function engineFor(config: WorkflowConfig, options: WorkflowEngineOptions = {}): WorkflowEngine {
    const engine = new WorkflowEngine(config, cloneA, 'test task', {
      projectCwd,
      provider: 'mock',
      model: 'test-model',
      reportDirName: 'engine-run',
      ...options,
    });
    engines.push(engine);
    return engine;
  }

  function receivedSessions(): Array<string | undefined> {
    return vi.mocked(runAgent).mock.calls.map(([, , options]) => options?.sessionId);
  }

  it('should resume each persona on its second step and persist the current clone sessions', async () => {
    const result = await executeWorkflow(reviewAndFix(), 'test task', cloneA, {
      projectCwd, provider: 'mock', model: 'test-model', reportDirName: 'normal-run', outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(receivedSessions()).toEqual([undefined, undefined, 'session-1', 'session-2']);
    expect(loadWorktreeSessions(projectCwd, cloneA, 'mock')).toMatchObject({
      '["reviewer","mock","test-model"]': 'session-3',
      '["coder","mock","test-model"]': 'session-4',
    });
  });

  it('should keep clone and project sessions separate when another clone starts', async () => {
    const config = workflow([agentStep('review', 'reviewer', 'COMPLETE')]);
    const key = buildSessionKey(config.steps[0]!, { provider: 'mock', model: 'test-model' });
    updatePersonaSession(projectCwd, key, 'project-session', 'mock');
    const options = { projectCwd, provider: 'mock' as const, model: 'test-model', outputMode: 'silent' as const };

    expect((await executeWorkflow(config, 'test task', cloneA, { ...options, reportDirName: 'clone-a-run' })).success).toBe(true);
    expect((await executeWorkflow(config, 'test task', cloneB, { ...options, reportDirName: 'clone-b-run' })).success).toBe(true);

    expect(receivedSessions()).toEqual([undefined, undefined]);
    expect(loadWorktreeSessions(projectCwd, cloneA, 'mock')).toMatchObject({ [key]: 'session-1' });
    expect(loadWorktreeSessions(projectCwd, cloneB, 'mock')).toMatchObject({ [key]: 'session-2' });
    expect(loadPersonaSessions(projectCwd, 'mock')).toMatchObject({ [key]: 'project-session' });
  });

  it.each(['retry', 'requeue', 'instruct'] as const)('should start every persona fresh after %s and resume only the new attempt', async (resumeMode) => {
    const interrupted = workflow([
      agentStep('review', 'reviewer', 'fix'),
      agentStep('fix', 'coder', 'ABORT'),
    ]);
    const options = { projectCwd, provider: 'mock' as const, model: 'test-model', outputMode: 'silent' as const };
    const first = await executeWorkflow(interrupted, 'test task', cloneA, { ...options, reportDirName: 'previous-run' });
    expect(first.success).toBe(false);
    expect(loadWorktreeSessions(projectCwd, cloneA, 'mock')).toMatchObject({
      '["reviewer","mock","test-model"]': 'session-1',
      '["coder","mock","test-model"]': 'session-2',
    });

    const second = await executeWorkflow(reviewAndFix(), 'test task', cloneA, {
      ...options,
      reportDirName: 'next-run',
      resumeSource: { sourceRunSlug: 'previous-run', resumeMode },
    });

    expect(second.success).toBe(true);
    expect(receivedSessions()).toEqual([undefined, undefined, undefined, undefined, 'session-3', 'session-4']);
  });

  it('should resume parallel sub-step personas from the first round', async () => {
    const parallel = (name: string, next: string): WorkflowStep => makeStep({
      name,
      parallel: [
        agentStep('architecture', 'reviewer', 'COMPLETE'),
        agentStep('security', 'security-reviewer', 'COMPLETE'),
      ],
      rules: [makeRule('when(true)', next)],
    });
    const engine = engineFor(workflow([
      parallel('reviews', 'fix'),
      agentStep('fix', 'coder', 'reviews-again'),
      parallel('reviews-again', 'COMPLETE'),
    ]));

    expect((await engine.run()).status).toBe('completed');
    for (const persona of ['reviewer', 'security-reviewer']) {
      const calls = vi.mocked(runAgent).mock.calls.filter(([name]) => name === persona);
      expect(calls).toHaveLength(2);
      expect(calls[0]![2]?.sessionId).toBeUndefined();
      const firstCall = vi.mocked(runAgent).mock.calls.indexOf(calls[0]!);
      expect(calls[1]![2]?.sessionId).toBe(`session-${firstCall + 1}`);
    }
  });

  it('should pass the parent session to a child workflow and resume the child result in the parent', async () => {
    const child: WorkflowConfig = {
      ...workflow([agentStep('child-review', 'reviewer', 'COMPLETE')]),
      name: 'child',
      subworkflow: { callable: true },
    };
    const parent = workflow([
      agentStep('review', 'reviewer', 'delegate'),
      { name: 'delegate', kind: 'workflow_call', call: 'child', rules: [makeRule('COMPLETE', 'review-again')] },
      agentStep('review-again', 'reviewer', 'COMPLETE'),
    ]);
    const engine = engineFor(parent, { workflowCallResolver: () => child });

    expect((await engine.run()).status).toBe('completed');
    expect(receivedSessions()).toEqual([undefined, 'session-1', 'session-2']);
  });

  it('should keep provider and model session identities separate inside a worktree', async () => {
    const engine = engineFor(workflow([
      agentStep('review', 'reviewer', 'other-persona'),
      agentStep('other-persona', 'coder', 'other-provider'),
      agentStep('other-provider', 'reviewer', 'other-model', { provider: 'codex', model: 'test-model' }),
      agentStep('other-model', 'reviewer', 'review-again', { provider: 'mock', model: 'other-model' }),
      agentStep('review-again', 'reviewer', 'COMPLETE'),
    ]));

    expect((await engine.run()).status).toBe('completed');
    expect(receivedSessions()).toEqual([undefined, undefined, undefined, undefined, 'session-1']);
  });

  it('should start refresh fresh and let the next step resume the refreshed session', async () => {
    const engine = engineFor(workflow([
      agentStep('review', 'reviewer', 'refresh'),
      agentStep('refresh', 'reviewer', 'review-again', { session: 'refresh' }),
      agentStep('review-again', 'reviewer', 'COMPLETE'),
    ]));

    expect((await engine.run()).status).toBe('completed');
    expect(receivedSessions()).toEqual([undefined, undefined, 'session-2']);
  });

  it('should compact the current worktree session before the compact step executes', async () => {
    const order: string[] = [];
    compactSession.mockImplementation(async () => { order.push('compact'); });
    const normalRun = vi.mocked(runAgent).getMockImplementation()!;
    vi.mocked(runAgent).mockImplementation(async (...args) => {
      order.push('agent');
      return normalRun(...args);
    });
    const engine = engineFor(workflow([
      agentStep('review', 'reviewer', 'compact'),
      agentStep('compact', 'reviewer', 'COMPLETE', { session: 'compact' }),
    ]));

    expect((await engine.run()).status).toBe('completed');
    expect(receivedSessions()).toEqual([undefined, 'session-1']);
    expect(compactSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: cloneA, sessionId: 'session-1', model: 'test-model' }));
    expect(order).toEqual(['agent', 'compact', 'agent']);
  });
});
