import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RunAgentOptions } from '../agents/runner.js';
import type { StructuredCaller } from '../agents/structured-caller.js';
import type { AgentResponse, McpServerConfig, WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { buildSessionKey } from '../core/workflow/session-key.js';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { buildMcpServerSetIdentity } from '../infra/config/runtime-provider/mcp-schema.js';
import type { McpAssignmentSection } from '../infra/config/runtime-provider/mcp-assignment.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

const mcpServers: Record<string, McpServerConfig> = {
  dummy: { type: 'stdio', command: 'node' },
};

const variants: [string, McpAssignmentSection | undefined][] = [
  ['without MCP servers', undefined],
  ['with runtime MCP servers', { servers: mcpServers, defaults: { servers: ['dummy'] } }],
];

interface AgentCall {
  readonly persona: string;
  readonly inputSessionId: string | undefined;
  readonly outputSessionId: string;
  readonly mcpServerNames: string[];
}

function recordAgentCalls(
  returnsEmptyContent: (options: RunAgentOptions | undefined) => boolean = () => false,
): AgentCall[] {
  const calls: AgentCall[] = [];
  vi.mocked(runAgent).mockImplementation(async (persona, task, options) => {
    const personaName = typeof persona === 'string' ? persona : '';
    options?.onPromptResolved?.({ systemPrompt: personaName, userInstruction: task });
    const outputSessionId = `s-${calls.length + 1}`;
    calls.push({
      persona: personaName,
      inputSessionId: options?.sessionId,
      outputSessionId,
      mcpServerNames: Object.keys(options?.mcpServers ?? {}),
    });
    return {
      persona: personaName,
      status: 'done',
      content: returnsEmptyContent(options) ? '' : '# Report\ndone',
      sessionId: outputSessionId,
      timestamp: new Date('2026-10-01T00:00:00Z'),
    } satisfies AgentResponse;
  });
  return calls;
}

function structuredCaller(judgeStatus: StructuredCaller['judgeStatus']): StructuredCaller {
  return {
    judgeStatus,
    evaluateCondition: vi.fn(),
    decomposeTask: vi.fn(),
    requestMoreParts: vi.fn(),
  };
}

function agentStep(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name,
    persona: 'coder',
    personaDisplayName: 'Coder',
    instruction: `Do ${name}.`,
    passPreviousResponse: true,
    ...overrides,
  } as WorkflowStep;
}

describe('WorkflowEngine persona session resume with runtime MCP servers', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-session-it-'));
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.each(variants)('should resume Phase 1 in Phase 2 and continue it in the next step %s', async (_name, mcpAssignment) => {
    const calls = recordAgentCalls();
    const config: WorkflowConfig = {
      name: 'mcp-session-resume',
      maxSteps: 5,
      initialStep: 'step_a',
      steps: [
        agentStep('step_a', {
          outputContracts: [{ name: 'a.md', format: '## A' }],
          rules: [normalizeRule({ condition: 'done', next: 'step_b' })],
        }),
        agentStep('step_b', {
          session: 'refresh',
          outputContracts: [{ name: 'b.md', format: '## B' }],
          rules: [normalizeRule({ condition: 'done', next: 'step_c' })],
        }),
        agentStep('step_c', {
          rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        }),
      ],
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'task', {
      projectCwd: tmpRoot,
      provider: 'mock',
      reportDirName: 'mcp-session-resume',
      structuredCaller: structuredCaller(vi.fn()),
      mcpAssignment,
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(calls.map((call) => call.inputSessionId)).toEqual([undefined, 's-1', undefined, 's-3', 's-4']);
    expect(calls.map((call) => call.mcpServerNames)).toEqual(
      Array(5).fill(mcpAssignment === undefined ? [] : ['dummy']),
    );
  });

  it.each(variants)('should resume each parallel sub-step Phase 1 in its Phase 2 %s', async (_name, mcpAssignment) => {
    const calls = recordAgentCalls();
    const subStep = (name: string, persona: string): WorkflowStep => agentStep(name, {
      persona,
      outputContracts: [{ name: `${name}.md`, format: '## Review' }],
      rules: [normalizeRule({ condition: 'approved', next: 'COMPLETE' })],
    });
    const config: WorkflowConfig = {
      name: 'mcp-session-resume-parallel',
      maxSteps: 2,
      initialStep: 'reviewers',
      steps: [
        agentStep('reviewers', {
          persona: undefined,
          parallel: [subStep('arch-review', 'architect'), subStep('qa-review', 'qa')],
          rules: [normalizeRule({ condition: 'all("approved")', next: 'COMPLETE' })],
        }),
      ],
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'task', {
      projectCwd: tmpRoot,
      provider: 'mock',
      reportDirName: 'mcp-session-resume-parallel',
      structuredCaller: structuredCaller(vi.fn()),
      mcpAssignment,
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(calls.map((call) => call.persona).sort()).toEqual(['architect', 'architect', 'qa', 'qa']);
    expect(calls.map((call) => call.mcpServerNames)).toEqual(
      Array(4).fill(mcpAssignment === undefined ? [] : ['dummy']),
    );
    for (const persona of ['architect', 'qa']) {
      const [phase1, phase2] = calls.filter((call) => call.persona === persona);
      expect(phase1?.inputSessionId).toBeUndefined();
      expect(phase2?.inputSessionId).toBe(phase1?.outputSessionId);
    }
  });

  it.each(variants)('should invalidate the resumed session after rule detection is exhausted %s', async (_name, mcpAssignment) => {
    const calls = recordAgentCalls();
    const step = agentStep('implement', {
      rules: [
        normalizeRule({ condition: 'done', next: 'COMPLETE' }),
        normalizeRule({ condition: 'retry', next: 'implement' }),
      ],
    });
    const sessionKey = buildSessionKey(step, {
      provider: 'mock',
      mcpServerIdentity: mcpAssignment === undefined ? undefined : buildMcpServerSetIdentity(mcpServers),
    });
    const onSessionUpdate = vi.fn();
    const engine = new WorkflowEngine({
      name: 'mcp-session-invalidation',
      maxSteps: 1,
      initialStep: 'implement',
      steps: [step],
    }, tmpRoot, 'task', {
      projectCwd: tmpRoot,
      provider: 'mock',
      reportDirName: 'mcp-session-invalidation',
      initialSessions: { [sessionKey]: 'session-old' },
      onSessionUpdate,
      structuredCaller: structuredCaller(vi.fn().mockImplementation(async (_structured, _tag, _candidates, options) => {
        options.onStructuredPromptResolved?.({ systemPrompt: 'judge', userInstruction: 'judge' });
        throw new RuleDetectionExhaustedError('implement');
      })),
      mcpAssignment,
    });

    const state = await engine.run();

    expect(state.status).toBe('aborted');
    expect(calls.map((call) => call.inputSessionId)).toEqual(['session-old']);
    expect([...state.personaSessions.keys()]).toEqual([]);
    expect(onSessionUpdate).toHaveBeenLastCalledWith(sessionKey, undefined);
  });

  it.each(variants)('should resume the report fallback session in a later step on the fallback provider %s', async (_name, mcpAssignment) => {
    const calls = recordAgentCalls((options) =>
      options?.resolvedProvider === 'opencode' && options.permissionMode === 'readonly');
    const config: WorkflowConfig = {
      name: 'mcp-session-resume-report-fallback',
      maxSteps: 2,
      initialStep: 'step_a',
      steps: [
        agentStep('step_a', {
          outputContracts: [{ name: 'a.md', format: '## A' }],
          rules: [normalizeRule({ condition: 'done', next: 'step_b' })],
        }),
        agentStep('step_b', {
          rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
        }),
      ],
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'task', {
      projectCwd: tmpRoot,
      provider: 'opencode',
      model: 'opencode/qwen3-coder-next',
      providerRouting: { steps: { step_b: { provider: 'codex', model: 'gpt-5-report' } } },
      reportFallbackProvider: { provider: 'codex', model: 'gpt-5-report' },
      reportDirName: 'mcp-session-resume-report-fallback',
      structuredCaller: structuredCaller(vi.fn()),
      mcpAssignment,
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(calls.map((call) => call.inputSessionId)).toEqual([undefined, 's-1', undefined, undefined, 's-4']);
    expect(calls.map((call) => call.mcpServerNames)).toEqual(
      Array(5).fill(mcpAssignment === undefined ? [] : ['dummy']),
    );
  });

  it('should not share a Phase 1 session between steps with different MCP server sets', async () => {
    const calls = recordAgentCalls();
    const config: WorkflowConfig = {
      name: 'mcp-session-mixed',
      maxSteps: 3,
      initialStep: 'step_a',
      steps: [
        agentStep('step_a', { rules: [normalizeRule({ condition: 'done', next: 'step_b' })] }),
        agentStep('step_b', { rules: [normalizeRule({ condition: 'done', next: 'step_c' })] }),
        agentStep('step_c', { rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })] }),
      ],
    };
    const engine = new WorkflowEngine(config, tmpRoot, 'task', {
      projectCwd: tmpRoot,
      provider: 'mock',
      reportDirName: 'mcp-session-mixed',
      structuredCaller: structuredCaller(vi.fn()),
      mcpAssignment: {
        servers: mcpServers,
        targets: {
          steps: {
            'mcp-session-mixed/step_a': { servers: ['dummy'] },
            'mcp-session-mixed/step_c': { servers: ['dummy'] },
          },
        },
      },
    });

    const state = await engine.run();

    expect(state.status).toBe('completed');
    expect(calls.map((call) => call.mcpServerNames)).toEqual([['dummy'], [], ['dummy']]);
    expect(calls.map((call) => call.inputSessionId)).toEqual([undefined, undefined, 's-1']);
  });
});
