import { expect, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { runAgent } from '../../agents/runner.js';
import {
  loadWorkflowByIdentifier,
  resolveWorkflowCallTarget,
} from '../../infra/config/index.js';
import { normalizeWorkflowConfig } from '../../infra/config/loaders/workflowParser.js';
import { makeResponse } from '../engine-test-helpers.js';
import type { AutoRoutingConfig } from '../../core/models/index.js';
import { GitSelectorCommandRunner } from '../../infra/task/selector-git-command-runner.js';

export function createWorkflowCallProgressDeps() {
  return {
    sharedRuntime: { startedAtMs: Date.now() },
  };
}

export function createOwnedResumePoint(workflow: string, step: string, iteration: number) {
  return {
    version: 2 as const,
    stack: [{ workflow, step, kind: 'agent' as const, step_iterations: {} }],
    iteration,
    max_steps: 4,
    elapsed_ms: 0,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

export function writeWorkflow(projectDir: string, relativePath: string, content: string): void {
  const filePath = join(projectDir, '.takt', 'workflows', relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}

export function createParentWorkflow(projectDir: string, raw: Record<string, unknown>) {
  return normalizeWorkflowConfig(raw, projectDir);
}

export function loadWorkflowOrThrow(identifier: string, projectDir: string, basePath?: string) {
  const workflow = loadWorkflowByIdentifier(identifier, projectDir, basePath ? { basePath } : undefined);
  expect(workflow).not.toBeNull();
  return workflow!;
}

export function createWorkflowCallOptions(
  projectDir: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projectCwd: projectDir,
    provider: 'mock',
    model: 'parent-model',
    selectorGitCommandRunner: new GitSelectorCommandRunner(),
    workflowCallResolver: ({
      parentWorkflow,
      step,
      projectCwd: resolverProjectCwd,
      lookupCwd,
    }: {
      parentWorkflow: Parameters<typeof resolveWorkflowCallTarget>[0];
      step: Parameters<typeof resolveWorkflowCallTarget>[1];
      projectCwd: Parameters<typeof resolveWorkflowCallTarget>[2];
      lookupCwd: string;
    }) => resolveWorkflowCallTarget(parentWorkflow, step, resolverProjectCwd, lookupCwd),
    ...overrides,
  };
}

export function createWorkflowCallAutoRoutingConfig(): AutoRoutingConfig {
  return {
    strategy: 'balanced',
    router: {
      provider: 'claude-sdk',
      model: 'claude-haiku-4-5-20251001',
    },
    candidates: [
      {
        name: 'delegate-runtime',
        description: 'Workflow call delegation',
        provider: 'mock',
        model: 'parent-model',
        routingTier: 'medium',
      },
      {
        name: 'reasoning',
        description: 'Architecture and planning',
        provider: 'claude-sdk',
        model: 'claude-opus-4-20250514',
        routingTier: 'high',
      },
      {
        name: 'coding',
        description: 'Implementation and tests',
        provider: 'codex',
        model: 'gpt-5',
        routingTier: 'medium',
      },
      {
        name: 'lightweight',
        description: 'Formatting',
        provider: 'claude-sdk',
        model: 'claude-haiku-4-5-20251001',
        routingTier: 'low',
      },
    ],
    defaultPool: 'general',
    candidatePools: {
      general: {
        candidates: ['lightweight', 'delegate-runtime', 'coding', 'reasoning'],
        fallback: 'reasoning',
      },
    },
    rules: {
      steps: {
        delegate: 'delegate-runtime',
      },
    },
  };
}

export function mockPersonaResponses(responses: Record<string, string>, fallback = 'Parent delegate placeholder'): void {
  vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
    options?.onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: prompt,
    });

    const personaName = typeof persona === 'string' ? persona : '';
    const matchedPersona = Object.keys(responses).find((key) => personaName.includes(key));

    return makeResponse({
      persona: personaName || 'delegate',
      content: matchedPersona ? responses[matchedPersona]! : fallback,
    });
  });
}
