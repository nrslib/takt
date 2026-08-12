import { describe, expect, it } from 'vitest';
import type { InternalAgentSeats } from '../core/models/config-types.js';
import { loopJudgeProviderFields } from '../core/workflow/loop-judge-step.js';
import { internalAgentSeatOverride } from '../core/workflow/internal-agent-seat.js';

describe('internalAgentSeatOverride', () => {
  it('bakes a seat in as a step-direct provider/model', () => {
    expect(internalAgentSeatOverride({
      provider: 'opencode',
      model: 'seat-model',
      providerOptions: { opencode: { agent: 'build' } },
      permissionMode: 'readonly',
    })).toEqual({
      provider: 'opencode',
      providerSpecified: true,
      model: 'seat-model',
      modelSpecified: true,
      internalProviderOptions: { opencode: { agent: 'build' } },
      internalPermissionMode: 'readonly',
    });
  });

  it('leaves the exact permission unset when the seat omits it', () => {
    expect(internalAgentSeatOverride({ provider: 'opencode', model: 'seat-model' }))
      .not.toHaveProperty('internalPermissionMode');
  });

  it('returns nothing for an unset seat', () => {
    expect(internalAgentSeatOverride(undefined)).toBeUndefined();
    expect(internalAgentSeatOverride({ model: 'model-only' })).toBeUndefined();
  });
});

describe('loop-judge seat', () => {
  const seats: InternalAgentSeats = {
    loopJudge: { provider: 'opencode', model: 'seat-judge' },
  };

  it('propagates an explicitly configured permission mode', () => {
    expect(loopJudgeProviderFields({}, {
      loopJudge: { provider: 'opencode', model: 'seat-judge', permissionMode: 'readonly' },
    })).toEqual({
      provider: 'opencode',
      providerSpecified: true,
      model: 'seat-judge',
      modelSpecified: true,
      internalPermissionMode: 'readonly',
    });
  });

  it('replaces the workflow judge provider/model when assigned', () => {
    expect(loopJudgeProviderFields({ provider: 'codex', model: 'judge-model' }, seats)).toEqual({
      provider: 'opencode',
      providerSpecified: true,
      model: 'seat-judge',
      modelSpecified: true,
    });
  });

  it('keeps the workflow judge fields without a seat', () => {
    expect(loopJudgeProviderFields({ provider: 'codex', model: 'judge-model' }, undefined)).toEqual({
      provider: 'codex',
      model: 'judge-model',
    });
    expect(loopJudgeProviderFields({}, {})).toEqual({});
  });
});
