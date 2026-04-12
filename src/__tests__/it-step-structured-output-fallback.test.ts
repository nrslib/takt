import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';

const {
  mockGetProvider,
  mockProviderCall,
} = vi.hoisted(() => ({
  mockGetProvider: vi.fn(),
  mockProviderCall: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

import { WorkflowEngine } from '../core/workflow/index.js';

describe('workflow structured_output fallback integration', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'takt-structured-fallback-'));
    mkdirSync(join(projectDir, '.takt', 'schemas'), { recursive: true });
    writeFileSync(
      join(projectDir, '.takt', 'schemas', 'followup-task.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
        },
        required: ['action'],
      }),
      'utf-8',
    );
    mockGetProvider.mockImplementation((provider: string) => ({
      supportsStructuredOutput: false,
      setup: vi.fn(() => ({
        call: (...args: unknown[]) => mockProviderCall(provider, ...args),
      })),
    }));
    mockProviderCall.mockResolvedValue({
      persona: 'planner',
      status: 'done',
      content: '```json\n{"action":"noop"}\n```',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('parses step structured_output from prompt-based JSON when the resolved provider lacks native support', async () => {
    const config = normalizeWorkflowConfig(
      {
        name: 'step-structured-output-fallback',
        initial_step: 'plan_followup',
        max_steps: 2,
        schemas: {
          'followup-task': 'followup-task',
        },
        steps: [
          {
            name: 'plan_followup',
            persona: 'planner',
            provider: 'cursor',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-task',
            },
            rules: [
              {
                when: 'structured.plan_followup.action == "noop"',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
      projectCwd: projectDir,
      provider: 'claude',
      detectRuleIndex,
      structuredCaller: {
        judgeStatus: vi.fn(),
        evaluateCondition: vi.fn().mockResolvedValue(-1),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      reportDirName: 'test-report-dir',
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect(mockGetProvider).toHaveBeenCalledWith('cursor');
    expect((stateRecord.structuredOutputs as Map<string, unknown>).get('plan_followup')).toEqual({
      action: 'noop',
    });
  });

  it('supports schema_ref with type unions and format in prompt-based structured_output fallback', async () => {
    writeFileSync(
      join(projectDir, '.takt', 'schemas', 'followup-contact.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          contact: {
            type: ['string', 'null'],
            format: 'email',
          },
        },
        required: ['contact'],
        additionalProperties: false,
      }),
      'utf-8',
    );
    mockProviderCall.mockResolvedValue({
      persona: 'planner',
      status: 'done',
      content: '```json\n{"contact":"user@example.com"}\n```',
      timestamp: new Date('2026-04-01T00:00:00.000Z'),
    });

    const config = normalizeWorkflowConfig(
      {
        name: 'step-structured-output-fallback',
        initial_step: 'plan_followup',
        max_steps: 2,
        schemas: {
          'followup-contact': 'followup-contact',
        },
        steps: [
          {
            name: 'plan_followup',
            persona: 'planner',
            provider: 'cursor',
            instruction: 'Plan the next follow-up action.',
            structured_output: {
              schema_ref: 'followup-contact',
            },
            rules: [
              {
                when: 'structured.plan_followup.contact == "user@example.com"',
                next: 'COMPLETE',
              },
            ],
          },
        ],
      },
      projectDir,
    );

    const engine = new WorkflowEngine(config, projectDir, 'Current task body', {
      projectCwd: projectDir,
      provider: 'claude',
      detectRuleIndex,
      structuredCaller: {
        judgeStatus: vi.fn(),
        evaluateCondition: vi.fn().mockResolvedValue(-1),
        decomposeTask: vi.fn(),
        requestMoreParts: vi.fn(),
      },
      reportDirName: 'test-report-dir',
    });

    const state = await engine.run();
    const stateRecord = state as Record<string, unknown>;

    expect(state.status).toBe('completed');
    expect((stateRecord.structuredOutputs as Map<string, unknown>).get('plan_followup')).toEqual({
      contact: 'user@example.com',
    });
  });
});
