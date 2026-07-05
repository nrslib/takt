import { createHash } from 'node:crypto';
import type { AutoRoutingCandidate, AutoRoutingConfig, Language } from '../core/models/config-types.js';
import { runAgent, type RunAgentOptions, type StreamCallback } from './runner.js';
import { buildMaxTurnsOption } from './provider-call-options.js';

export interface AutoRoutingAiStep {
  id: string;
  name: string;
  tags?: string[];
  personaKey?: string;
  instruction?: string;
}

export interface AutoRoutingAiRouterOptions {
  cwd: string;
  workflowName: string;
  runId: string;
  language?: Language;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  onStream?: StreamCallback;
}

export interface AutoRoutingAiRouter {
  routeStep(autoRouting: AutoRoutingConfig, step: Omit<AutoRoutingAiStep, 'id'>): Promise<AutoRoutingCandidate | undefined>;
  routeBatch(autoRouting: AutoRoutingConfig, steps: AutoRoutingAiStep[]): Promise<Map<string, AutoRoutingCandidate | undefined>>;
}

const ROUTING_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    selected_candidate: { type: 'string' },
    selections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          selected_candidate: { type: 'string' },
        },
        required: ['id', 'selected_candidate'],
      },
    },
  },
};

const AUTO_ROUTING_AI_TIMEOUT_MS = 30_000;

function formatCandidates(autoRouting: AutoRoutingConfig): string {
  return autoRouting.candidates
    .map((candidate) => [
      `name: ${candidate.name}`,
      `description: ${candidate.description}`,
      `provider: ${candidate.provider}`,
      `model: ${candidate.model}`,
      `cost_tier: ${candidate.costTier}`,
    ].join('\n'))
    .join('\n\n');
}

function formatStep(step: AutoRoutingAiStep): string {
  return [
    `id: ${step.id}`,
    `name: ${step.name}`,
    `tags: ${(step.tags ?? []).join(', ')}`,
    `persona: ${step.personaKey ?? ''}`,
  ].join('\n');
}

function buildRoutingPrompt(
  workflowName: string,
  autoRouting: AutoRoutingConfig,
  steps: AutoRoutingAiStep[],
): string {
  const strategyInstruction = {
    cost: 'Choose the cheapest candidate that can complete the task correctly.',
    balanced: 'Choose the best task fit. Do not optimize primarily for cost tier.',
    performance: 'Choose the candidate most likely to produce the highest quality result.',
  }[autoRouting.strategy];

  return [
    'Select the best auto routing candidate for each workflow step.',
    `Workflow: ${workflowName}`,
    `Strategy: ${autoRouting.strategy}`,
    strategyInstruction,
    '',
    'Candidates:',
    formatCandidates(autoRouting),
    '',
    'Steps:',
    steps.map(formatStep).join('\n\n'),
    '',
    'Return JSON only. For one step use {"selected_candidate":"name"}. For multiple steps use {"selections":[{"id":"step-id","selected_candidate":"name"}]}.',
  ].join('\n');
}

function findCandidate(autoRouting: AutoRoutingConfig, name: unknown): AutoRoutingCandidate | undefined {
  return typeof name === 'string'
    ? autoRouting.candidates.find((candidate) => candidate.name === name)
    : undefined;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw new Error('Auto routing AI response did not contain JSON');
    }
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  }
}

function parseSelections(
  autoRouting: AutoRoutingConfig,
  steps: AutoRoutingAiStep[],
  response: Record<string, unknown>,
): Map<string, AutoRoutingCandidate | undefined> {
  const result = new Map<string, AutoRoutingCandidate | undefined>();
  if (steps.length === 1) {
    const step = steps[0];
    if (step === undefined) {
      throw new Error('Auto routing AI selection requires a step');
    }
    result.set(step.id, findCandidate(autoRouting, response.selected_candidate));
    return result;
  }

  const selections = Array.isArray(response.selections) ? response.selections : [];
  for (const selection of selections) {
    if (typeof selection !== 'object' || selection === null) {
      continue;
    }
    const entry = selection as Record<string, unknown>;
    if (typeof entry.id === 'string') {
      result.set(entry.id, findCandidate(autoRouting, entry.selected_candidate));
    }
  }
  return result;
}

function hashInstruction(instruction: string | undefined): string {
  return createHash('sha256').update(instruction ?? '').digest('hex');
}

function createRoutingCacheKey(runId: string, step: AutoRoutingAiStep): string {
  return [runId, step.name, hashInstruction(step.instruction)].join('\0');
}

async function runAutoRouterAgent(
  autoRouting: AutoRoutingConfig,
  options: AutoRoutingAiRouterOptions,
  prompt: string,
): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Auto routing AI router timed out after ${AUTO_ROUTING_AI_TIMEOUT_MS}ms`));
      controller.abort();
    }, AUTO_ROUTING_AI_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      runAgent('auto-router', prompt, {
        cwd: options.cwd,
        provider: autoRouting.router.provider,
        resolvedProvider: autoRouting.router.provider,
        model: autoRouting.router.model,
        resolvedModel: autoRouting.router.model,
        ...buildMaxTurnsOption(autoRouting.router.provider, autoRouting.router.provider, 1),
        abortSignal: controller.signal,
        permissionMode: 'readonly',
        language: options.language,
        childProcessEnv: options.childProcessEnv,
        onStream: options.onStream,
        outputSchema: ROUTING_OUTPUT_SCHEMA,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function createAutoRoutingAiRouter(options: AutoRoutingAiRouterOptions): AutoRoutingAiRouter {
  const routingDecisionCache = new Map<string, AutoRoutingCandidate | undefined>();

  async function routeBatch(
    autoRouting: AutoRoutingConfig,
    steps: AutoRoutingAiStep[],
  ): Promise<Map<string, AutoRoutingCandidate | undefined>> {
    const result = new Map<string, AutoRoutingCandidate | undefined>();
    const uncachedSteps: AutoRoutingAiStep[] = [];
    const cacheKeyByStepId = new Map<string, string>();

    for (const step of steps) {
      const cacheKey = createRoutingCacheKey(options.runId, step);
      if (routingDecisionCache.has(cacheKey)) {
        result.set(step.id, routingDecisionCache.get(cacheKey));
        continue;
      }
      uncachedSteps.push(step);
      cacheKeyByStepId.set(step.id, cacheKey);
    }

    if (uncachedSteps.length === 0) {
      return result;
    }

    const prompt = buildRoutingPrompt(options.workflowName, autoRouting, uncachedSteps);
    const response = await runAutoRouterAgent(autoRouting, options, prompt);
    if (response.status !== 'done') {
      throw new Error(response.error ?? response.content ?? 'Auto routing AI router failed');
    }

    const parsed = response.structuredOutput ?? parseJsonObject(response.content);
    const parsedSelections = parseSelections(autoRouting, uncachedSteps, parsed);
    for (const step of uncachedSteps) {
      const candidate = parsedSelections.get(step.id);
      const cacheKey = cacheKeyByStepId.get(step.id);
      if (cacheKey === undefined) {
        throw new Error(`Missing auto routing cache key for step "${step.id}"`);
      }
      routingDecisionCache.set(cacheKey, candidate);
      result.set(step.id, candidate);
    }
    return result;
  }

  return {
    async routeStep(autoRouting, step) {
      const result = await routeBatch(autoRouting, [{ id: step.name, ...step }]);
      return result.get(step.name);
    },
    routeBatch,
  };
}
