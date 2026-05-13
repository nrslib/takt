import { afterEach, describe, expect, it, vi } from 'vitest';

const { debugSpy } = vi.hoisted(() => ({
  debugSpy: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    debug: debugSpy,
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  })),
}));

import { runReportPhase, type PhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { WorkflowStep } from '../core/models/types.js';

function createStep(): WorkflowStep {
  return {
    name: 'audit',
    persona: 'testing-reviewer',
    personaDisplayName: 'Testing Reviewer',
    instruction: 'Audit task',
    passPreviousResponse: false,
    outputContracts: [],
  };
}

function createContext(): PhaseRunnerContext {
  return {
    cwd: '/tmp/report-phase-logging',
    reportDir: '/tmp/report-phase-logging/reports',
    lastResponse: 'Phase 1 result',
    resolveSessionKey: (step) => step.persona ?? step.name,
    getSessionId: () => 'sensitive-session-token',
    buildResumeOptions: () => ({ cwd: '/tmp/report-phase-logging' }),
    buildNewSessionReportOptions: () => ({ cwd: '/tmp/report-phase-logging' }),
    updatePersonaSession: () => {},
  };
}

describe('runReportPhase logging', () => {
  afterEach(() => {
    debugSpy.mockClear();
  });

  it('should log report phase startup without exposing the raw sessionId', async () => {
    // Given
    const step = createStep();
    const ctx = createContext();

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const runningLog = debugSpy.mock.calls.find(([message]) => message === 'Running report phase');
    expect(runningLog).toBeDefined();

    const metadata = runningLog?.[1] as Record<string, unknown>;
    expect(metadata).toEqual({
      step: 'audit',
      hasSession: true,
      hasLastResponse: true,
    });
    expect(JSON.stringify(metadata)).not.toContain('sensitive-session-token');
  });
});
