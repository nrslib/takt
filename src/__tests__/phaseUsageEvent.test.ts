import { describe, expect, it } from 'vitest';
import {
  mapSpanEndToPhaseUsageEvent,
  type PhaseUsageEventContext,
} from '../core/logging/phaseUsageEvent.js';
import type { SpanSnapshot } from '../core/logging/span-to-ndjson-mapper.js';

const context: PhaseUsageEventContext = {
  runId: 'run-1',
  sessionId: 'session-1',
};

describe('phase usage event mapper', () => {
  it('maps phase 1 spans into phase usage event records', () => {
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.execution_id': 'implement:1:1:1',
        'takt.phase.status': 'done',
        'takt.usage.missing': false,
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
        'gen_ai.usage.cached_input_tokens': 3,
        'gen_ai.usage.cache_creation_input_tokens': 2,
        'gen_ai.usage.cache_read_input_tokens': 1,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toEqual({
      run_id: 'run-1',
      session_id: 'session-1',
      provider: 'codex',
      provider_model: 'gpt-5',
      step: 'implement',
      step_type: 'agent',
      phase: 'phase1_execute',
      phase_name: 'execute',
      phase_execution_id: 'implement:1:1:1',
      timestamp: '2026-05-14T16:46:45.000Z',
      success: true,
      usage_missing: false,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        cached_input_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
      },
    });
  });

  it('maps phase 2 missing usage with a normalized reason', () => {
    const span: SpanSnapshot = {
      name: 'phase.review.report',
      endTime: [1_778_777_210, 0],
      attributes: {
        'takt.provider.name': 'claude',
        'takt.step.name': 'review',
        'takt.step.type': 'agent',
        'takt.phase.number': 2,
        'takt.phase.name': 'report',
        'takt.phase.status': 'error',
        'takt.usage.missing': true,
        'takt.usage.missing_reason': 'unexpected',
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toEqual(expect.objectContaining({
      provider: 'claude',
      provider_model: '(default)',
      phase: 'phase2_report',
      phase_name: 'report',
      success: false,
      usage_missing: true,
      reason: 'usage_not_available',
      usage: {},
    }));
  });

  it('maps judge stage spans into stage-specific phase usage records', () => {
    const span: SpanSnapshot = {
      name: 'judge_stage.implement.3.ai_judge',
      endTime: [1_778_777_215, 0],
      attributes: {
        'takt.provider.name': 'claude-sdk',
        'takt.model.name': 'claude-sonnet-4',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.phase.execution_id': 'implement:3:1:1',
        'takt.judge.stage': 3,
        'takt.judge.method': 'ai_judge',
        'takt.judge.status': 'done',
        'gen_ai.usage.input_tokens': 5,
        'gen_ai.usage.output_tokens': 4,
      },
    };

    expect(mapSpanEndToPhaseUsageEvent(span, context)).toEqual(expect.objectContaining({
      phase: 'phase3_fallback',
      phase_name: 'judge',
      phase_execution_id: 'implement:3:1:1',
      judge_stage: 3,
      judge_method: 'ai_judge',
      usage_missing: false,
      usage: {
        input_tokens: 5,
        output_tokens: 4,
        total_tokens: 9,
      },
    }));
  });

  it('skips phase 3 parent spans and spans missing required provider or step metadata', () => {
    expect(mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.judge',
      attributes: {
        'takt.provider.name': 'codex',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.phase.number': 3,
        'takt.phase.name': 'judge',
      },
    }, context)).toBeUndefined();

    expect(mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.execute',
      attributes: {
        'takt.step.name': 'implement',
        'takt.step.type': 'normal',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
      },
    }, context)).toBeUndefined();
  });

  it('turns partial token attributes into usage_tokens_missing', () => {
    const record = mapSpanEndToPhaseUsageEvent({
      name: 'phase.implement.execute',
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 5,
      },
    }, context);

    expect(record).toMatchObject({
      usage_missing: true,
      reason: 'usage_tokens_missing',
      usage: {},
    });
  });

  it('includes step tags and persona from a phase span', () => {
    // Given a phase span carrying step tags and persona attributes
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.persona': 'coder',
        'takt.step.tags': ['coding', 'review'],
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then the record carries the tags array and persona
    expect(record).toMatchObject({
      tags: ['coding', 'review'],
      persona: 'coder',
    });
  });

  it('includes step tags and persona from a judge stage span', () => {
    // Given a judge stage span carrying step tags and persona attributes
    const span: SpanSnapshot = {
      name: 'judge_stage.implement.3.ai_judge',
      endTime: [1_778_777_215, 0],
      attributes: {
        'takt.provider.name': 'claude-sdk',
        'takt.model.name': 'claude-sonnet-4',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.persona': 'conductor',
        'takt.step.tags': ['review'],
        'takt.judge.stage': 3,
        'takt.judge.method': 'ai_judge',
        'takt.judge.status': 'done',
        'gen_ai.usage.input_tokens': 5,
        'gen_ai.usage.output_tokens': 4,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then the record carries the tags array and persona
    expect(record).toMatchObject({
      tags: ['review'],
      persona: 'conductor',
    });
  });

  it('omits the tags and persona keys when the span has neither attribute', () => {
    // Given a phase span without persona or tags (e.g. a system step)
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'mock',
        'takt.step.name': 'init',
        'takt.step.type': 'system',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
        'gen_ai.usage.total_tokens': 2,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then neither key is present (no empty defaults are emitted)
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('tags');
    expect(record).not.toHaveProperty('persona');
  });

  it('omits the tags key when the span carries an empty tags array', () => {
    // Given a phase span whose tags attribute is an empty array
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.persona': 'coder',
        'takt.step.tags': [],
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then the empty array is not emitted, while persona still is
    expect(record).not.toHaveProperty('tags');
    expect(record).toMatchObject({ persona: 'coder' });
  });

  it('ignores a non-array tags attribute', () => {
    // Given a phase span whose tags attribute is malformed (not an array)
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.tags': 'coding',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then the malformed value is rejected rather than passed through
    expect(record).not.toHaveProperty('tags');
  });

  it('ignores a tags array containing a non-string element', () => {
    // Given a phase span whose tags array carries a non-string element
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.tags': ['coding', 42],
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then the whole array is rejected rather than partially emitted
    expect(record).not.toHaveProperty('tags');
  });

  it('ignores a tags array containing an empty string element', () => {
    // Given a phase span whose tags array carries an empty string element
    const span: SpanSnapshot = {
      name: 'phase.implement.execute',
      endTime: [1_778_777_205, 0],
      attributes: {
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.step.tags': ['coding', ''],
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
      },
    };

    // When the span is mapped to a phase usage event record
    const record = mapSpanEndToPhaseUsageEvent(span, context);

    // Then the whole array is rejected rather than partially emitted
    expect(record).not.toHaveProperty('tags');
  });
});
