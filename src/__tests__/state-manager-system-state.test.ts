import { describe, expect, it } from 'vitest';
import { createInitialState } from '../core/workflow/engine/state-manager.js';
import type { WorkflowConfig } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function makeConfig(): WorkflowConfig {
  return {
    name: 'system-workflow',
    initialStep: 'route_context',
    maxSteps: 5,
    steps: [],
  };
}

function makeOptions(): WorkflowEngineOptions {
  return {
    projectCwd: '/tmp/project',
  };
}

describe('state-manager system state', () => {
  it('system workflow 用の state 領域を初期化する', () => {
    const state = createInitialState(makeConfig(), makeOptions()) as Record<string, unknown>;

    expect(state.structuredOutputs).toBeInstanceOf(Map);
    expect(state.systemContexts).toBeInstanceOf(Map);
    expect(state.effectResults).toBeInstanceOf(Map);
    expect((state.structuredOutputs as Map<string, unknown>).size).toBe(0);
    expect((state.systemContexts as Map<string, unknown>).size).toBe(0);
    expect((state.effectResults as Map<string, unknown>).size).toBe(0);
  });
});
