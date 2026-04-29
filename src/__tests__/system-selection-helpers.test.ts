import { describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import {
  getCachedCandidateSnapshot,
  readPreviousSelectedNumber,
  readResolvedBindingNumber,
  selectNextCandidate,
} from '../infra/workflow/system/system-selection-helpers.js';

function createWorkflowState(): WorkflowState {
  return {
    workflowName: 'auto-improvement-loop',
    currentStep: 'route_context',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('system-selection-helpers', () => {
  it('candidate snapshot を resolution context 内で一度だけ評価する', () => {
    const loadCandidates = vi.fn(() => [{ number: 587 }, { number: 586 }]);
    const resolutionContext = {
      cache: new Map<string, unknown>(),
      resolvedBindings: new Map<string, unknown>(),
    };

    const first = getCachedCandidateSnapshot('issue_candidates:test', loadCandidates, resolutionContext);
    const second = getCachedCandidateSnapshot('issue_candidates:test', loadCandidates, resolutionContext);

    expect(loadCandidates).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('前回選択番号の次候補へ巡回する', () => {
    expect(selectNextCandidate(
      [{ number: 587 }, { number: 586 }],
      587,
    )).toEqual({ number: 586 });
  });

  it('workflow state から前回選択番号を読む', () => {
    const state = createWorkflowState();
    state.systemContexts.set('route_context', {
      selected_issue: { exists: true, number: 586 },
    });

    expect(readPreviousSelectedNumber(state, 'route_context', 'selected_issue')).toBe(586);
  });

  it('resolution context から同一 step の解決済み番号を読む', () => {
    const resolutionContext = {
      cache: new Map<string, unknown>(),
      resolvedBindings: new Map<string, unknown>([
        ['selected_issue', { exists: true, number: 586 }],
      ]),
    };

    expect(readResolvedBindingNumber(resolutionContext, 'selected_issue')).toBe(586);
  });
});
