import { describe, expect, it } from 'vitest';
import {
  mapSpanEndToNdjson,
  mapSpanStartToNdjson,
  type SpanSnapshot,
} from '../core/logging/span-to-ndjson-mapper.js';

describe('span-to-ndjson mapper', () => {
  it('maps step span start and end into session log compatible records', () => {
    const stack = [
      { workflow: 'parent', workflow_ref: 'project:sha256:parent', step: 'delegate', kind: 'workflow_call' },
      { workflow: 'child', workflow_ref: 'project:sha256:child', step: 'implement', kind: 'agent' },
    ];
    const baseSpan: SpanSnapshot = {
      name: 'step.implement',
      startTime: [1_778_777_200, 123_000_000],
      endTime: [1_778_777_210, 456_000_000],
      attributes: {
        'takt.workflow.name': 'parent',
        'takt.workflow.current_name': 'child',
        'takt.workflow.stack': JSON.stringify(stack),
        'takt.step.name': 'implement',
        'takt.step.persona': 'coder',
        'takt.step.iteration': 2,
        'takt.step.instruction': 'Implement it',
        'takt.provider.name': 'codex',
        'takt.provider.source': 'project',
        'takt.model.name': 'gpt-5',
        'takt.model.source': 'global',
        'takt.step.status': 'done',
        'takt.step.result.persona': 'coder',
        'takt.step.result.content': 'done',
        'takt.step.result.timestamp': '2026-05-18T00:00:00.000Z',
        'takt.step.result.matched_rule_index': 0,
        'takt.step.result.matched_rule_method': 'structured_output',
        'takt.step.result.match_method': 'structured_output',
        'takt.step.result.failure_category': 'provider_error',
      },
    };

    expect(mapSpanStartToNdjson(baseSpan)).toEqual({
      type: 'step_start',
      step: 'implement',
      persona: 'coder',
      iteration: 2,
      timestamp: '2026-05-14T16:46:40.123Z',
      workflow: 'child',
      stack,
      instruction: 'Implement it',
      provider: 'codex',
      providerSource: 'project',
      model: 'gpt-5',
      modelSource: 'global',
    });

    expect(mapSpanEndToNdjson(baseSpan)).toEqual({
      type: 'step_complete',
      step: 'implement',
      persona: 'coder',
      iteration: 2,
      status: 'done',
      content: 'done',
      instruction: 'Implement it',
      workflow: 'child',
      stack,
      matchedRuleIndex: 0,
      matchedRuleMethod: 'structured_output',
      matchMethod: 'structured_output',
      failureCategory: 'provider_error',
      timestamp: '2026-05-18T00:00:00.000Z',
    });
  });

  it('omits invalid failureCategory values from mapped records', () => {
    expect(mapSpanEndToNdjson({
      name: 'step.implement',
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.persona': 'coder',
        'takt.step.iteration': 1,
        'takt.step.status': 'error',
        'takt.step.result.content': 'failed',
        'takt.step.result.failure_category': 'unexpected',
      },
    })).toEqual({
      type: 'step_complete',
      step: 'implement',
      persona: 'coder',
      iteration: 1,
      status: 'error',
      content: 'failed',
      instruction: '',
      timestamp: expect.any(String),
    });
  });

  it('maps terminal workflow spans and skips non-terminal running spans', () => {
    expect(mapSpanEndToNdjson({
      name: 'workflow.default',
      endTime: [1_778_777_300, 0],
      attributes: {
        'takt.workflow.status': 'completed',
        'takt.workflow.iterations': 3,
      },
    })).toEqual({
      type: 'workflow_complete',
      iterations: 3,
      endTime: '2026-05-14T16:48:20.000Z',
    });

    expect(mapSpanEndToNdjson({
      name: 'workflow.default',
      attributes: {
        'takt.workflow.status': 'running',
      },
    })).toBeUndefined();
  });
});
