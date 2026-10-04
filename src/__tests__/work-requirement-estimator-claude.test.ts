import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutingModelInput } from '../core/workflow/auto-routing/contracts.js';

const { query } = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query,
  AbortError: class AbortError extends Error {},
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/config/index.js')>(),
  loadAgentPrompt: vi.fn(() => ''),
  loadCustomAgents: vi.fn(() => new Map()),
  loadGlobalConfig: vi.fn(() => ({})),
  loadPersonaPromptFromPath: vi.fn(() => ''),
  loadProjectConfig: vi.fn(() => ({})),
  resolveAnthropicApiKey: vi.fn(() => undefined),
  resolveClaudeCliPath: vi.fn(() => undefined),
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/config/resolveConfigValue.js')>(),
  resolveConfigValue: vi.fn(() => undefined),
  resolveProviderOptionsWithTrace: vi.fn(() => ({
    value: undefined,
    source: 'default',
    originResolver: () => 'default',
  })),
}));

import { createWorkRequirementEstimator } from '../agents/auto-routing-usecase.js';
import { ProviderRegistry } from '../infra/providers/index.js';
import { QueryRegistry } from '../infra/claude/query-manager.js';

function createSdkQuery(structuredOutput: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        structured_output: structuredOutput,
      };
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
  };
}

function createModelInput(): RoutingModelInput {
  return {
    version: 'routing-model-input/v1',
    goal: 'Implement a focused validation fix',
    step: {
      name: 'implement',
      tags: ['implementation'],
      stepType: 'normal',
      edit: true,
    },
    remainingWork: [{ source: 'task', description: 'A validation branch is incomplete.' }],
    progress: {
      previousAttemptFailed: false,
      noProgress: false,
      retryingSameWork: false,
    },
  };
}

describe('work requirement estimator Claude provider integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ProviderRegistry.resetInstance();
    QueryRegistry.resetInstance();
  });

  it('Given a Claude SDK router, When querying the Agent SDK, Then the common raw schema reaches outputFormat and its structured value is used', async () => {
    query.mockReturnValue(createSdkQuery({
      required_tier: 'high',
      reason_codes: ['complex-work'],
      confidence: null,
    }));
    const estimator = createWorkRequirementEstimator({
      cwd: '/repo',
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    });

    await expect(estimator.estimate(createModelInput())).resolves.toEqual({
      requiredTier: 'high',
      reasonCodes: ['complex-work'],
    });

    expect(query).toHaveBeenCalledOnce();
    const queryInput = query.mock.calls[0]?.[0] as {
      options?: {
        outputFormat?: {
          type?: unknown;
          schema?: Record<string, unknown>;
        };
      };
    } | undefined;
    expect(queryInput?.options?.outputFormat).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          required_tier: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason_codes: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'api-change',
                'complex-work',
                'focused-change',
                'formatting',
                'initial-complexity',
                'local-change',
              ],
            },
          },
          confidence: { type: ['number', 'null'] },
        },
        required: ['required_tier', 'reason_codes', 'confidence'],
      },
    });
  });
});
