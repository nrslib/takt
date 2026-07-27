import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

function setup() {
  const storage = createRealRunStorage();
  const owner = storage.root.claimLease({
      ownerKey: 'owner-1',
      leaseDurationMs: 9_000,
  });
  const runtime = storage.root.runtime({ lease: owner });
  return { ...storage, owner, runtime };
}

const request = {
  codecName: 'json-v1',
  content: '{"prompt":"hello"}',
} as const;

describe('operation state machine', () => {
  it('loads a matching scoped idempotency key and rejects collisions', () => {
    const { runtime } = setup();
    const first = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });
    const replay = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });

    expect(replay.state).toBe(first.state);
    expect(() => runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request: { ...request, content: '{"prompt":"different"}' },
    })).toThrow(/authority collision/i);
  });

  it('separates the same idempotency key by scope', () => {
    const { root, owner, runtime } = setup();
    const childScope = runtime.scopes.createParallelChild({ scopeKey: 'child' });
    const child = root.runtime({ lease: owner, scope: childScope });

    const parentOperation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'same',
      kind: 'provider',
      request,
    });
    const childOperation = child.operations.prepareOrLoad({
      idempotencyKey: 'same',
      kind: 'provider',
      request,
    });

    expect(root.readResumeSnapshot().operations).toHaveLength(2);
    expect(() => child.operations.get(parentOperation.handle))
      .toThrow(/cross-scope/i);
  });

  it('generates transition and attempt history from legal commands', () => {
    const { root, runtime } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });
    runtime.operations.claimPrepared(operation.handle);
    runtime.operations.recordResponse({
      operation: operation.handle,
      response: { codecName: 'json-v1', content: '{"answer":"ok"}' },
    });
    runtime.operations.markApplied(operation.handle);

    expect(runtime.operations.get(operation.handle).state).toBe('applied');
    expect(root.readResumeSnapshot().operationTransitions.map((row) => row.to_state))
      .toEqual(['prepared', 'dispatching', 'response_recorded', 'applied']);
    expect(root.readResumeSnapshot().operationAttempts).toEqual([
      expect.objectContaining({
        outcome: 'response_recorded',
      }),
    ]);
  });

  it('preserves a recorded response when application fails', () => {
    const { runtime } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'provider-call',
      kind: 'provider',
      request,
    });
    runtime.operations.claimPrepared(operation.handle);
    runtime.operations.recordResponse({
      operation: operation.handle,
      response: { codecName: 'json-v1', content: '{"answer":"ok"}' },
    });
    runtime.operations.markFailed({
      operation: operation.handle,
      error: { codecName: 'text-v1', content: 'apply failed' },
    });

    expect(runtime.operations.get(operation.handle)).toMatchObject({
      state: 'failed',
      response: { encoded: '{"answer":"ok"}' },
      error: { encoded: 'apply failed' },
    });
  });

  it.each([
    ['prepared', 'failed'],
    ['prepared', 'cancelled'],
    ['dispatching', 'failed'],
    ['dispatching', 'unknown_after_dispatch'],
    ['response_recorded', 'applied'],
  ] as const)('supports crash matrix %s -> %s', (from, target) => {
    const { runtime } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: `${from}-${target}`,
      kind: 'provider',
      request,
    });
    if (from === 'dispatching' || from === 'response_recorded') {
      runtime.operations.claimPrepared(operation.handle);
    }
    if (from === 'response_recorded') {
      runtime.operations.recordResponse({
        operation: operation.handle,
        response: { codecName: 'json-v1', content: '{"answer":"ok"}' },
      });
    }
    switch (target) {
      case 'failed':
        runtime.operations.markFailed({
          operation: operation.handle,
          error: { codecName: 'text-v1', content: 'failed' },
        });
        break;
      case 'cancelled':
        runtime.operations.cancelPrepared(operation.handle);
        break;
      case 'unknown_after_dispatch':
        runtime.operations.recoverAfterDispatchCrash(operation.handle);
        break;
      case 'applied':
        runtime.operations.markApplied(operation.handle);
        break;
    }
    expect(runtime.operations.get(operation.handle).state).toBe(target);
  });

  it('rejects terminal resurrection and stale lease commands', () => {
    const { root, owner, runtime, clock } = setup();
    const operation = runtime.operations.prepareOrLoad({
      idempotencyKey: 'cancel',
      kind: 'provider',
      request,
    });
    runtime.operations.cancelPrepared(operation.handle);
    expect(() => runtime.operations.claimPrepared(operation.handle)).toThrow(/prepared/);

    root.releaseLease(owner);
    clock.set(2_000);
    root.claimLease({
      ownerKey: 'owner-2',
      leaseDurationMs: 9_000,
    });
    expect(() => runtime.operations.prepareOrLoad({
      idempotencyKey: 'stale',
      kind: 'provider',
      request,
    })).toThrow(/stale/i);
  });
});
