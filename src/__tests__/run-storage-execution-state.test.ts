import { afterEach, describe, expect, it } from 'vitest';
import type { LeaseHandle } from '../infra/run-storage/runtime-handles.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function claim(root: ReturnType<typeof createRealRunStorage>['root']): LeaseHandle {
  return root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
  });
}

describe('run execution authority', () => {
  it('keeps root, workflow_call, and parallel scopes in one run database', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });

    runtime.scopes.createWorkflowCallChild({
      scopeKey: 'call-1',
    });
    runtime.scopes.createParallelChild({ scopeKey: 'parallel-1' });

    expect(root.readResumeSnapshot().scopes.map((scope) => scope.kind).sort())
      .toEqual(['parallel', 'root', 'workflow_call']);
  });

  it('advances independent event sequences for parallel child scopes', () => {
    const { root } = createRealRunStorage();
    const owner = claim(root);
    const parent = root.runtime({ lease: owner });
    const firstScope = parent.scopes.createParallelChild({ scopeKey: 'parallel-1' });
    const secondScope = parent.scopes.createParallelChild({ scopeKey: 'parallel-2' });
    const first = root.runtime({ lease: owner, scope: firstScope });
    const second = root.runtime({ lease: owner, scope: secondScope });

    expect(first.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'started',
    })).toBe(1);
    expect(second.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'started',
    })).toBe(1);
    expect(first.sequences.appendEvent({
      expectedSequence: 1,
      eventType: 'completed',
    })).toBe(2);

    expect(first.sequences.listEvents().map((event) => event.sequence)).toEqual([1, 2]);
    expect(second.sequences.listEvents().map((event) => event.sequence)).toEqual([1]);
  });

  it('persists complete resumable execution state with scoped CAS', () => {
    const { root, clock } = createRealRunStorage();
    const owner = claim(root);
    const runtime = root.runtime({ lease: owner });
    const step = runtime.execution.startStep({
      stepKey: 'implement',
      expectedScopeRevision: 0,
    });
    const phase = runtime.execution.startPhase({
      execution: step.handle,
      phase: 'agent',
      ordinal: 0,
    });
    runtime.execution.recordJudgeStage({
      phaseExecution: phase,
      stage: 'quality',
      codecName: 'json-v1',
      result: '{"ok":true}',
    });
    runtime.execution.recordStepOutput({
      execution: step.handle,
      outputName: 'answer',
      codecName: 'text-v1',
      content: 'done',
    });
    runtime.execution.recordStructuredOutput({
      execution: step.handle,
      codecName: 'json-v1',
      output: '{"status":"done"}',
    });
    runtime.runtimeValues.recordSystemContext({
      contextKey: 'initial',
      codecName: 'text-v1',
      content: 'system',
    });
    runtime.runtimeValues.recordEffectResult({
      effectKey: 'command-1',
      effectType: 'command',
      codecName: 'json-v1',
      result: '{"exit":0}',
    });
    runtime.runtimeValues.recordUserInput({
      inputKey: 'approval-1',
      codecName: 'text-v1',
      content: 'yes',
    });
    const persona = runtime.runtimeValues.startPersonaSession({
      sessionKey: 'coder',
      personaName: 'coder',
    });
    runtime.runtimeValues.appendPersonaSessionRevision({
      personaSession: persona,
      expectedRevision: 0,
      codecName: 'text-v1',
      content: 'state',
    });
    runtime.sequences.recordResponseSnapshot({
      expectedSequence: 0,
      codecName: 'text-v1',
      response: 'previous response',
    });
    const recovery = runtime.runtimeValues.createRecoveryItem({
      recoveryKey: 'recovery-1',
      itemType: 'provider',
      codecName: 'json-v1',
      content: '{}',
    });
    clock.set(2_000);
    runtime.runtimeValues.resolveRecoveryItem({
      recovery,
      status: 'applied',
    });
    runtime.execution.finishPhase({
      phaseExecution: phase,
      status: 'completed',
    });
    runtime.execution.finishStep({
      execution: step.handle,
      status: 'completed',
    });

    const scope = root.readResumeSnapshot().scopes[0];
    expect(scope?.stepExecutions).toHaveLength(1);
    expect(scope?.phaseExecutions).toHaveLength(1);
    expect(scope?.judgeStageResults).toHaveLength(1);
    expect(scope?.stepOutputs).toHaveLength(1);
    expect(scope?.structuredOutputs).toHaveLength(1);
    expect(scope?.systemContexts).toHaveLength(1);
    expect(scope?.effectResults).toHaveLength(1);
    expect(scope?.userInputs).toHaveLength(1);
    expect(scope?.personaSessions).toHaveLength(1);
    expect(scope?.responses).toHaveLength(1);
    expect(scope?.recoveryItems).toEqual([
      expect.objectContaining({ status: 'applied', terminalAt: 2_000 }),
    ]);
  });

  it('rejects stale leases, duplicate children, cross-scope writes, and resurrection', () => {
    const { root, clock } = createRealRunStorage();
    const firstOwner = claim(root);
    const rootRuntime = root.runtime({ lease: firstOwner });
    const childScope = rootRuntime.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: firstOwner, scope: childScope });
    const execution = child.execution.startStep({
      stepKey: 'review',
      expectedScopeRevision: 0,
    });

    expect(() => rootRuntime.scopes.createParallelChild({ scopeKey: 'child' }))
      .toThrow(/UNIQUE/);
    expect(() => rootRuntime.execution.finishStep({
      execution: execution.handle,
      status: 'completed',
    })).toThrow(/cross-scope/);

    child.execution.finishStep({
      execution: execution.handle,
      status: 'completed',
    });
    child.scopes.terminalize({
      expectedRevision: 1,
      expectedStatus: 'running',
      status: 'completed',
    });
    expect(() => Reflect.apply(child.scopes.transition, child.scopes, [{
      expectedRevision: 2,
      expectedStatus: 'completed',
      status: 'running',
      currentStepId: 'review',
    }])).toThrow(/Terminal scope/);

    root.releaseLease(firstOwner);
    clock.set(3_000);
    const secondOwner = root.claimLease({
      ownerKey: 'owner-2',
      leaseDurationMs: 9_000,
    });
    expect(() => rootRuntime.sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'stale',
    })).toThrow(/stale/i);
    expect(root.runtime({ lease: secondOwner }).sequences.appendEvent({
      expectedSequence: 0,
      eventType: 'current',
    })).toBe(1);
  });
});
