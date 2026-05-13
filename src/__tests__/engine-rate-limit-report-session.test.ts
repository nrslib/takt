import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentResponse, WorkflowConfig, WorkflowRule, WorkflowStep } from '../core/models/index.js';
import type { WorkflowEngineOptions } from '../core/workflow/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import { WorkflowEngine } from '../core/workflow/index.js';

function makeRule(condition: string, next: string): WorkflowRule {
  return { condition, next };
}

function makeStep(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name,
    persona: 'coder',
    personaDisplayName: 'Coder',
    instruction: `Run ${name}`,
    passPreviousResponse: false,
    rules: [makeRule('true', 'COMPLETE')],
    ...overrides,
  };
}

function makeResponse(overrides: Partial<AgentResponse>): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: 'done',
    timestamp: new Date('2026-05-13T03:00:00.000Z'),
    ...overrides,
  };
}

function makeRateLimitedResponse(): AgentResponse {
  return makeResponse({
    status: 'rate_limited' as never,
    content: '',
    error: 'Rate limit exceeded. Please try again later.',
    errorKind: 'rate_limit',
    rateLimitInfo: {
      provider: 'claude',
      detectedAt: new Date('2026-05-13T03:00:00.000Z'),
      source: 'sdk_error',
    },
  });
}

function queueRunAgentResponses(responses: AgentResponse[]): void {
  const mock = vi.mocked(runAgent);
  for (const response of responses) {
    mock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return response;
    });
  }
}

function buildConfig(): WorkflowConfig {
  return {
    name: 'rate-limit-report-session',
    maxSteps: 5,
    initialStep: 'plan',
    steps: [
      makeStep('plan', {
        outputContracts: [{ name: 'plan.md', useJudge: false }],
        rules: [makeRule('true', 'verify')],
      }),
      makeStep('verify', {
        rules: [makeRule('true', 'COMPLETE')],
      }),
    ],
  };
}

function buildTeamLeaderReportConfig(): WorkflowConfig {
  return {
    name: 'team-leader-rate-limit-report-session',
    maxSteps: 5,
    initialStep: 'implement',
    steps: [
      makeStep('implement', {
        outputContracts: [{ name: 'implement.md', useJudge: false }],
        teamLeader: {
          persona: '../personas/team-leader.md',
          maxParts: 1,
          refillThreshold: 0,
          timeoutMs: 10000,
          partPersona: '../personas/coder.md',
          partAllowedTools: ['Read', 'Edit'],
          partEdit: true,
          partPermissionMode: 'edit',
        },
        rules: [makeRule('true', 'COMPLETE')],
      }),
    ],
  };
}

function buildOptions(tmpDir: string): WorkflowEngineOptions {
  return {
    projectCwd: tmpDir,
    provider: 'claude',
    model: 'claude-sonnet',
    reportDirName: 'test-report-dir',
    detectRuleIndex: () => 0,
    rateLimitFallback: {
      switchChain: [{ provider: 'codex', model: 'gpt-5' }],
    },
  };
}

function providerCalls(): Array<{ resolvedProvider?: string; sessionId?: string }> {
  return vi.mocked(runAgent).mock.calls.map((call) => ({
    resolvedProvider: call[2].resolvedProvider,
    sessionId: call[2].sessionId,
  }));
}

describe('WorkflowEngine rate limit fallback report session continuity', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'takt-rate-limit-report-session-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fallback 後の report phase は fallback provider の Phase 1 session を resume し、次 step の claude に codex session を渡さない', async () => {
    // Given
    const engine = new WorkflowEngine(buildConfig(), tmpDir, 'test task', buildOptions(tmpDir));
    queueRunAgentResponses([
      makeResponse({ content: '[STEP:1] plan done', sessionId: 'claude-session' }),
      makeRateLimitedResponse(),
      makeResponse({ content: '[STEP:1] plan done', sessionId: 'codex-session' }),
      makeResponse({ content: 'report from codex', sessionId: 'codex-report-session' }),
      makeResponse({ content: '[STEP:1] verify done', sessionId: 'verify-claude-session' }),
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls()).toEqual([
      { resolvedProvider: 'claude', sessionId: undefined },
      { resolvedProvider: 'claude', sessionId: 'claude-session' },
      { resolvedProvider: 'codex', sessionId: undefined },
      { resolvedProvider: 'codex', sessionId: 'codex-session' },
      { resolvedProvider: 'claude', sessionId: 'claude-session' },
    ]);
  });

  it('team_leader fallback 後の report phase は fallback provider runtime を使う', async () => {
    // Given
    const engine = new WorkflowEngine(buildTeamLeaderReportConfig(), tmpDir, 'test task', buildOptions(tmpDir));
    const parts = [{ id: 'part-1', title: 'API', instruction: 'Implement API' }];
    const doneFeedback = { done: true, reasoning: 'enough', parts: [] };
    queueRunAgentResponses([
      makeResponse({ persona: 'team-leader', structuredOutput: { parts }, sessionId: 'leader-claude-session' }),
      makeRateLimitedResponse(),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback, sessionId: 'feedback-claude-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: { parts }, sessionId: 'leader-codex-session' }),
      makeResponse({ persona: 'coder', content: '[STEP:1] done', sessionId: 'part-codex-session' }),
      makeResponse({ persona: 'team-leader', structuredOutput: doneFeedback, sessionId: 'feedback-codex-session' }),
      makeResponse({ persona: 'coder', content: 'report from codex', sessionId: 'report-codex-session' }),
    ]);

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(providerCalls()).toEqual([
      { resolvedProvider: 'claude', sessionId: undefined },
      { resolvedProvider: 'claude', sessionId: undefined },
      { resolvedProvider: 'claude', sessionId: undefined },
      { resolvedProvider: 'codex', sessionId: undefined },
      { resolvedProvider: 'codex', sessionId: undefined },
      { resolvedProvider: 'codex', sessionId: undefined },
      { resolvedProvider: 'codex', sessionId: undefined },
    ]);
  });
});
