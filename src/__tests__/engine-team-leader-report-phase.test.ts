import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('ja'),
  getDisabledBuiltins: vi.fn().mockReturnValue([]),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return 'ja';
    if (key === 'enableBuiltinWorkflows') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = 'ja';
      if (key === 'enableBuiltinWorkflows') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
  resolveProviderOptionsWithTrace: vi.fn(() => ({
    value: undefined,
    source: 'default',
    originResolver: () => 'default',
  })),
}));

import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflow } from '../infra/config/index.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';
import { makeRule } from './test-helpers.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type { AgentResponse, WorkflowConfig } from '../core/models/index.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

function createStructuredCaller(): StructuredCaller {
  return {
    judgeStatus: async () => {
      throw new Error('judgeStatus should not be called in this test');
    },
    evaluateCondition: async (content, conditions) => {
      for (const condition of conditions) {
        if (content.includes(condition.text)) {
          return condition.index;
        }
      }
      return -1;
    },
    decomposeTask: async (instruction, _maxTotalParts, options) => {
      options.onPromptResolved?.({
        systemPrompt: options.persona ?? 'testing-reviewer',
        userInstruction: instruction,
      });
      return [
        {
          id: 'part-1',
          title: 'Audit flow',
          instruction: 'Inspect the workflow end-to-end',
        },
      ];
    },
    requestMoreParts: async () => ({
      done: true,
      reasoning: 'enough coverage',
      parts: [],
    }),
  };
}

function createConfig(): WorkflowConfig {
  return {
    name: 'team-leader-report-fallback',
    description: 'Tests team leader report fallback',
    maxSteps: 5,
    initialStep: 'audit',
    steps: [
      {
        name: 'audit',
        persona: 'testing-reviewer',
        personaDisplayName: 'Testing Reviewer',
        instruction: 'Audit task: {task}',
        passPreviousResponse: false,
        teamLeader: {
          maxConcurrency: 1,
          maxTotalParts: 20,
          refillThreshold: 0,
          timeoutMs: 1_000,
          partPersona: 'testing-reviewer',
          partEdit: false,
          partPermissionMode: 'readonly',
        },
        outputContracts: [
          {
            name: '02-e2e-audit.md',
            format: '# E2E Audit Report',
          },
        ],
        rules: [
          makeRule('true', 'COMPLETE'),
        ],
      },
    ],
  };
}

function queueRunAgentResponses(responses: AgentResponse[]): void {
  const runAgentMock = vi.mocked(runAgent);
  for (const response of responses) {
    runAgentMock.mockImplementationOnce(async (persona, instruction, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return response;
    });
  }
}

describe('WorkflowEngine Integration: team_leader report phase fallback', () => {
  let tmpDir: string;
  let engine: WorkflowEngine | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'takt-team-leader-report-'));
  });

  afterEach(() => {
    engine?.removeAllListeners();
    engine = undefined;
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should generate the report in a new session when the team_leader root session is missing', async () => {
    // Given
    const reportDirName = 'test-report-dir';
    const reportPath = join(tmpDir, '.takt', 'runs', reportDirName, 'reports', '02-e2e-audit.md');
    queueRunAgentResponses([
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: 'Part audit finished',
        timestamp: new Date('2026-04-22T01:45:00Z'),
        sessionId: 'part-session-1',
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '# Audit Report\nEverything passed',
        timestamp: new Date('2026-04-22T01:45:01Z'),
        sessionId: 'report-session-1',
      },
    ]);
    engine = new WorkflowEngine(createConfig(), tmpDir, 'run audit', {
      projectCwd: tmpDir,
      provider: 'mock',
      reportDirName,
      detectRuleIndex,
      structuredCaller: createStructuredCaller(),
    });

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(readFileSync(reportPath, 'utf-8')).toBe('# Audit Report\nEverything passed');

    const runAgentMock = vi.mocked(runAgent);
    expect(runAgentMock).toHaveBeenCalledTimes(2);

    const reportInstruction = runAgentMock.mock.calls[1]?.[1] as string;
    const reportOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(reportOptions.sessionId).toBeUndefined();
    expect(reportInstruction).toContain('Part audit finished');
    expect(state.personaSessions.get('audit.part-1:mock')).toBe('part-session-1');
    expect(state.personaSessions.get('testing-reviewer:mock')).toBe('report-session-1');
  });

  it('should complete audit-e2e with a new report session for the audit step', async () => {
    // Given
    const reportDirName = 'test-report-dir';
    const reportPath = join(tmpDir, '.takt', 'runs', reportDirName, 'reports', '02-e2e-audit.md');
    const config = loadWorkflow('audit-e2e', tmpDir);
    expect(config).not.toBeNull();

    queueRunAgentResponses([
      {
        persona: 'test-planner',
        status: 'done',
        content: '監査計画が完了',
        timestamp: new Date('2026-04-22T01:50:00Z'),
        sessionId: 'plan-session-1',
      },
      {
        persona: 'test-planner',
        status: 'done',
        content: '# 監査計画\n対象フローを確定しました',
        timestamp: new Date('2026-04-22T01:50:01Z'),
        sessionId: 'plan-report-session-1',
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '監査完了\nAudit findings collected across all flows',
        timestamp: new Date('2026-04-22T01:50:02Z'),
        sessionId: 'part-session-1',
      },
      {
        persona: 'testing-reviewer',
        status: 'done',
        content: '# E2E Audit Report\n監査完了',
        timestamp: new Date('2026-04-22T01:50:03Z'),
        sessionId: 'audit-report-session-1',
      },
      {
        persona: 'supervisor',
        status: 'done',
        content: '監査が完全で Issue 化できる品質に達している',
        timestamp: new Date('2026-04-22T01:50:04Z'),
        sessionId: 'supervisor-session-1',
      },
    ]);
    engine = new WorkflowEngine(config!, tmpDir, 'run audit', {
      projectCwd: tmpDir,
      provider: 'mock',
      reportDirName,
      detectRuleIndex,
      structuredCaller: createStructuredCaller(),
    });

    // When
    const state = await engine.run();

    // Then
    expect(state.status).toBe('completed');
    expect(readFileSync(reportPath, 'utf-8')).toBe('# E2E Audit Report\n監査完了');

    const runAgentMock = vi.mocked(runAgent);
    expect(runAgentMock).toHaveBeenCalledTimes(5);

    const auditReportCall = runAgentMock.mock.calls.find(([, instruction]) => {
      return typeof instruction === 'string' && instruction.includes('02-e2e-audit.md');
    });
    expect(auditReportCall).toBeDefined();

    const auditReportInstruction = auditReportCall?.[1] as string;
    const auditReportOptions = auditReportCall?.[2] as { sessionId?: string };
    expect(auditReportOptions.sessionId).toBeUndefined();
    expect(auditReportInstruction).toContain('Audit findings collected across all flows');
  });
});
